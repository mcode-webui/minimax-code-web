"use client";

// This file imports React explicitly: webapp/test/usage-models-cards.test.ts
// renders it through react-dom/server under the tsx loader, which honours
// `jsx: "preserve"` by falling back to the classic runtime — there is no
// Next compiler in that process to inject the automatic one (same reason
// loading-states.tsx imports React).
import * as React from "react";
import type { MessageKey } from "@/lib/i18n";
import { Icon } from "./icons";
import { Switch } from "antd";

/**
 * The Token Plan view's pure display cards (ticket 53).
 *
 * Split out of panels.tsx on purpose: these four components take nothing
 * but a `t` function, so the test suite renders them through
 * react-dom/server (`usage-models-cards.test.ts`) the same way
 * loading-states.tsx is tested — panels.tsx itself pulls the session
 * store and the api graph and stays unimportable in a test process.
 *
 * The data policy lives in the panels.tsx section wrapper (decision A1/B1,
 * ticket 53): every figure region the local server has no source for
 * renders the 「本地版不适用」 placeholder, and controls keep the desktop
 * reference's form but disabled.
 */

/**
 * The 当前套餐 card — the reference's two-row plan card (plan name +
 * expiry over credits), a hairline between the rows, and the row actions:
 * the black 「升级」 primary button plus 「管理 ⌄」 on top, 「去充值」 plus
 * 「管理 ⌄」 below.
 *
 * The local edition has no cloud-account source for any of the figures, so
 * by decision A1 the data regions render the 「本地版不适用」 placeholder,
 * the expiry line is omitted rather than given a fabricated date, and every
 * action renders in the desktop's form but disabled — there is nothing
 * local for 升级 / 管理 / 去充值 to act on.
 */
export function PlanCard({ t }: { t: (key: MessageKey) => string }) {
  const manageButton = (testId: string) => (
    <button
      type="button"
      disabled
      data-testid={testId}
      className="flex h-7 cursor-not-allowed items-center gap-1 rounded-[8px] border border-border_default px-2.5 text-caption-small-strong text-text_default_primary opacity-50"
    >
      {t("usage.plan.manage")}
      <Icon name="chevronDown" size={12} />
    </button>
  );

  return (
    <div data-testid="settings-plan-card" className="flex w-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
        <span className="desktop-text-ui-body text-text_default_primary">
          {t("usage.plan.title")}
        </span>
        <Icon name="info" size={14} className="text-text_default_tertiary" />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-text_default_primary">
            {t("usage.notLocal")}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {/* The reference's black primary button, disabled (no local
           * plan to upgrade). */}
          <button
            type="button"
            disabled
            data-testid="plan-upgrade-button"
            className="h-7 cursor-not-allowed rounded-[8px] bg-bg_interaction_primary_default px-2.5 text-caption-small-strong text-icon_interaction_primary_default opacity-50"
          >
            {t("usage.plan.upgrade")}
          </button>
          {manageButton("plan-manage-button")}
        </div>
      </div>
      {/* The reference's hairline between the plan row and the credits
       * row — the same markup as panels.tsx's RowDivider, inlined here so
       * this module stays free of panels.tsx's import graph. */}
      <div className="flex items-center justify-center px-3 py-1.5" aria-hidden>
        <span className="block h-px w-full bg-border_light" />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm text-text_default_primary">{t("usage.credits")}</span>
          <span className="text-caption-small-strong text-text_default_secondary">
            {t("usage.notLocal")}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            disabled
            data-testid="plan-top-up-button"
            className="h-7 cursor-not-allowed rounded-[8px] border border-border_default px-2.5 text-caption-small-strong text-text_default_primary opacity-50"
          >
            {t("usage.plan.topUp")}
          </button>
          {manageButton("plan-credits-manage-button")}
        </div>
      </div>
    </div>
  );
}

/** One stacked progress bar of the usage card. Pure display: the container
 * in panels.tsx computes `used` from the quota store and picks the
 * placeholder line; this row only renders what it is given.
 *
 * Track colour note (acceptance F-1): the track is `bg-border_default`,
 * NOT the context meter's `bg-bg_grouped_tertiary_elevated` — in the light
 * theme that token resolves to the same grey as the section card
 * (`--gray_75` both), which made the bars invisible against the card. The
 * border grey keeps a visible step in both themes and matches the
 * reference's track grey. Pinned by the render test. */
export function UsageBar({
  label,
  testId,
  used,
  withTotal,
  placeholder,
  caption,
}: {
  label: string;
  testId: string;
  /** Used percent from the engine's remaining figure; null means "no
   * gauge to draw" and renders the placeholder line instead of 0%. */
  used: number | null;
  /** The 5-hour row prints "used% / 100%"; the others print "used%". */
  withTotal: boolean;
  /** The standing line for the figure slot when `used` is null. */
  placeholder: string;
  /** The relative reset caption under the bar, when a reading exists. */
  caption?: string | null;
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-normal text-text_default_primary">{label}</span>
        {used === null ? (
          <span className="text-caption-small-strong text-text_default_secondary">
            {placeholder}
          </span>
        ) : (
          <span className="text-sm font-normal text-text_default_primary">
            {withTotal ? `${used}% / 100%` : `${used}%`}
          </span>
        )}
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-border_default"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        {used !== null && used > 0 ? (
          <div
            className="h-full rounded-full bg-icon_default_accent"
            style={{ width: `${used}%` }}
          />
        ) : null}
      </div>
      {caption ? (
        <span className="text-caption-small-strong text-text_default_secondary">{caption}</span>
      ) : null}
    </div>
  );
}

/**
 * The 积分 card — the reference's one-row card with its ⓘ title, the
 * 「开启后…」 hint, and the blue iOS switch at the right edge.
 *
 * Decision B1: the switch renders the desktop's blue on-state form but is
 * disabled — the local edition has no credits system, so it neither
 * toggles nor persists state, and the row says so next to the hint.
 */
export function CreditsCard({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div data-testid="settings-credits-card" className="flex w-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <span className="desktop-text-ui-body text-text_default_primary">{t("usage.credits")}</span>
        <Icon name="info" size={14} className="text-text_default_tertiary" />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 pt-1.5 pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-caption-small-strong text-text_default_secondary">
            {t("usage.credits.hint")}
          </span>
          <span className="text-caption-small-strong text-text_default_tertiary">
            {t("usage.notLocal")}
          </span>
        </div>
        <div
          className="flex flex-shrink-0 items-center"
          data-testid="credits-spending-switch"
          title={t("usage.notLocal")}
        >
          <Switch checked disabled aria-label={t("usage.credits")} />
        </div>
      </div>
    </div>
  );
}

/**
 * The 发票 card — the reference's outbound row: the hint text plus the
 * 「申请 ↗」 link-button, white with the grey outline the 去充值 / 管理
 * buttons share (acceptance F-2). Unlike the other cards this one is fully
 * real: invoicing lives on the MiniMax open platform, so the link is live
 * and opens a new tab. (The ↗ glyph is the send/arrowUp icon rotated 45°,
 * the file's established way to reuse a glyph.)
 */
export function InvoiceCard({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div data-testid="settings-invoice-card" className="flex w-full flex-col">
      <div className="flex items-center px-3 pt-2">
        <span className="desktop-text-ui-body text-text_default_primary">
          {t("usage.invoice.title")}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 pt-1.5 pb-3">
        <span className="min-w-0 text-sm text-text_default_primary">{t("usage.invoice.hint")}</span>
        <a
          href="https://platform.minimaxi.com/"
          target="_blank"
          rel="noreferrer"
          data-testid="invoice-apply-link"
          className="flex h-7 flex-shrink-0 items-center gap-1 rounded-[8px] border border-border_default px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("usage.invoice.apply")}
          <Icon name="arrowUp" size={12} className="rotate-45" />
        </a>
      </div>
    </div>
  );
}

/**
 * The reset caption under a usage bar — the reference's relative form
 * 「43分后重置」 / 「4小时43分后重置」, built from the duration keys because
 * the translator takes no interpolation parameters (the same
 * `.replace("{n}", …)` convention as files.tree.mtime.*). Whole hours drop
 * the minute slot (「1小时后重置」, not 「1小时0分后重置」 — acceptance F-3').
 */
export function resetCaption(resetAt: number, t: (key: MessageKey) => string): string | null {
  const ms = (resetAt > 1e12 ? resetAt : resetAt * 1000) - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const span =
    hours > 0 && minutes === 0
      ? t("usage.duration.hour").replace("{n}", String(hours))
      : hours > 0
        ? t("usage.duration.hourMinute")
            .replace("{h}", String(hours))
            .replace("{n}", String(minutes))
        : t("usage.duration.minute").replace("{n}", String(minutes));
  return t("usage.resetsIn").replace("{t}", span);
}
