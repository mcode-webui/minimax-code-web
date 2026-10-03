"use client";

/**
 * Settings-modal port — the 账户 tab (SB-5).
 *
 * What this section answers, and what it deliberately does not. The desktop
 * reference shows an account page that answers "who am I / what plan am I on
 * / how much of the plan is left", and the ported shell had been rendering a
 * hardcoded 「本地模式，未登录」 line because no read had been wired. The
 * source exists and is already in production elsewhere in this file's
 * neighbourhood: `GET /api/account` feeds the user menu's account card
 * (`shell.tsx#SidebarFooter`), so this section reads the SAME projection
 * rather than inventing a second account endpoint.
 *
 * Division of labour with the Token Plan card (SB-7, `usage-models-cards.tsx`):
 * that card owns the LIMIT BARS and the plan actions — the gauges, the
 * upgrade button, credits, expiry and invoicing. This section owns IDENTITY
 * and the plain-text quota READINGS. The two overlap on purpose and only on
 * the plan NAME, which goes through the card's own `planNameOf` so there is
 * one definition of "is there a name to show?" in the codebase.
 *
 * No bars here, and no default values anywhere. Three states are
 * distinguished, because collapsing them would be the defect this batch
 * removes:
 *
 *   - `null` / never resolved  → the placeholder names the SOURCE
 *     (`GET /api/account`), so a reader knows a read is missing rather than
 *     that they have no account.
 *   - `ok: false`              → the engine answered and could not report an
 *     account. The engine's own `reason` is shown when it sent one.
 *   - `ok: true` but no figure → the engine answered and reported no such
 *     field. "No account name" and "quota not metered" are real readings.
 *
 * The sign-out button stays disabled by decision (`doc/settings-batch-plan.md`
 * §1.2): the engine exposes no sign-in/sign-out method, so a disabled button
 * with the honest tooltip is the accurate answer, not a gap.
 */

import { useEffect, useState, type ReactElement } from "react";

import * as api from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import { planNameOf } from "./usage-models-cards";

/** One quota window, resolved into "a figure to print" or "nothing to print". */
export interface AccountQuotaReading {
  /** Remaining percentage, already clamped to 0..100; null means no figure. */
  remainingPercent: number | null;
  /** True when the engine reported the window as unmetered — a reading. */
  unlimited: boolean;
}

export interface AccountQuotaReadout {
  /** The plan-quota state the engine reported, verbatim; null when it sent none. */
  state: "available" | "not-subscribed" | "unavailable" | null;
  fiveHour: AccountQuotaReading | null;
  weekly: AccountQuotaReading | null;
}

/**
 * Resolve one projected window.
 *
 * An unmetered window returns `unlimited: true` with NO percentage, because
 * 「剩余 0%」 would be a fabricated reading of a plan that has no cap. A
 * metered window with no percentage returns `remainingPercent: null` — the
 * engine said nothing, which is a different fact from saying zero.
 */
export function quotaWindowReading(
  window: api.AccountQuotaWindow | null | undefined,
): AccountQuotaReading | null {
  if (!window) return null;
  if (window.unlimited === true) return { remainingPercent: null, unlimited: true };
  const percent = window.remainingPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return { remainingPercent: null, unlimited: false };
  }
  return {
    remainingPercent: Math.max(0, Math.min(100, percent)),
    unlimited: false,
  };
}

/**
 * The account name to print, or null when there is none to print.
 *
 * A failed account surface and a blank name are the same fact to a reader —
 * no name is known — so both collapse to null, exactly as `planNameOf`
 * collapses them for the plan. The caller picks the placeholder, because the
 * two cases deserve different sentences (unreachable vs. no name reported).
 */
export function accountNameOf(
  account: api.AccountPayload | null | undefined,
): string | null {
  if (!account?.ok) return null;
  const name = account.identity?.name?.trim();
  return name ? name : null;
}

/** The quota state and per-window figures, or the empty reading when the
 * account surface failed. A failed surface is not a zero quota. */
export function accountQuotaOf(
  account: api.AccountPayload | null | undefined,
): AccountQuotaReadout {
  const empty: AccountQuotaReadout = { state: null, fiveHour: null, weekly: null };
  if (!account?.ok) return empty;
  return {
    state: account.tokenPlanQuotaState ?? null,
    fiveHour: quotaWindowReading(account.quota?.fiveHour),
    weekly: quotaWindowReading(account.quota?.weekly),
  };
}

/** The engine's machine-readable failure reason, when it sent one. */
export function accountReasonOf(
  account: api.AccountPayload | null | undefined,
): string | null {
  if (!account || account.ok) return null;
  const reason = account.reason?.trim();
  return reason ? reason : "account_unavailable";
}

/** Print one window's reading, or the honest "the engine sent no figure" line. */
function windowReadingText(
  t: (key: MessageKey) => string,
  label: string,
  reading: AccountQuotaReading | null,
): string {
  if (!reading) return `${label} · ${t("settings.account.quotaMissing")}`;
  if (reading.unlimited) return `${label} · ${t("settings.account.unlimited")}`;
  if (reading.remainingPercent === null) {
    return `${label} · ${t("settings.account.quotaMissing")}`;
  }
  return `${label} · ${t("settings.account.remaining").replace("{pct}", String(reading.remainingPercent))}`;
}

/** The quota-state sentence, or null when the engine reported no state. */
function quotaStateText(
  t: (key: MessageKey) => string,
  state: AccountQuotaReadout["state"],
): string | null {
  if (state === "available") return t("settings.account.quotaState.available");
  if (state === "not-subscribed") return t("settings.account.quotaState.notSubscribed");
  if (state === "unavailable") return t("settings.account.quotaState.unavailable");
  return null;
}

/**
 * The engine's account status, or null when it reported none. An unknown
 * status string maps to null rather than to the literal token: the
 * projection is an allow-list that may grow, and a raw enum leaking into the
 * UI is how a future field becomes a user-visible sentence nobody reviewed.
 */
export function accountStatusOf(
  account: api.AccountPayload | null | undefined,
): "ready" | "needs-login" | "warning" | "unknown" | null {
  if (!account?.ok) return null;
  const status = account.status;
  return status === "ready" || status === "needs-login" || status === "warning" || status === "unknown"
    ? status
    : null;
}

export function AccountSection({
  t,
}: {
  t: (key: MessageKey) => string;
}): ReactElement {
  const [account, setAccount] = useState<api.AccountPayload | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");

  // One read on mount. The projection is the user's own identity and it is
  // deliberately NOT in the state snapshot (the snapshot is broadcast to
  // every SSE subscriber, LAN included) — same reason `shell.tsx` reads on
  // demand. The tab mounts only when opened, so a reopening re-reads.
  useEffect(() => {
    let live = true;
    void api
      .getAccount()
      .then((payload) => {
        if (!live) return;
        setAccount(payload);
        setPhase("ready");
      })
      .catch(() => {
        if (live) setPhase("failed");
      });
    return () => {
      live = false;
    };
  }, []);

  const name = accountNameOf(account);
  const plan = planNameOf(account);
  const quota = accountQuotaOf(account);
  const reason = accountReasonOf(account);
  const status = accountStatusOf(account);

  // The one sentence that stands in for every missing reading, and it names
  // the endpoint rather than asserting a fact about the user.
  const unread =
    phase === "loading"
      ? t("settings.account.loading")
      : phase === "failed"
        ? t("settings.account.readFailed")
        : reason
          ? t("settings.account.unavailableReason").replace("{reason}", reason)
          : t("settings.account.unavailable");

  const planText = plan ?? (account?.ok ? t("usage.plan.noPlan") : unread);
  // Three sentences, not one: a failed surface, an answer with no name, and a
  // name. The middle case used to be impossible to express — the section
  // printed 「未登录」 for an engine that simply sent no identity field.
  const nameText = name ?? (account?.ok ? t("settings.account.nameMissing") : unread);
  const quotaLines: string[] = [];
  const stateText = quotaStateText(t, quota.state);
  if (stateText) quotaLines.push(stateText);
  if (account?.ok) {
    quotaLines.push(
      windowReadingText(t, t("usage.fiveHour"), quota.fiveHour),
      windowReadingText(t, t("usage.weekly"), quota.weekly),
    );
  }

  return (
    <section className="webui-settings-panel">
      <h3>{t("settings.tab.account")}</h3>
      <div>
        <div className="webui-settings-row">
          <div>
            <strong>{t("settings.account.name")}</strong>
            <span>{nameText}</span>
          </div>
        </div>
        <div className="webui-settings-row">
          <div>
            <strong>{t("usage.plan.title")}</strong>
            <span>{planText}</span>
          </div>
        </div>
        <div className="webui-settings-row">
          <div>
            <strong>{t("settings.account.quota")}</strong>
            <span>{quotaLines.length > 0 ? quotaLines.join(" · ") : unread}</span>
          </div>
        </div>
        <div className="webui-settings-row">
          <div>
            <strong>{t("settings.account.status")}</strong>
            <span>
              {status === null
                ? unread
                : t(`settings.account.status.${status}` as MessageKey)}
            </span>
          </div>
        </div>
        <div className="webui-settings-row">
          <button
            type="button"
            disabled
            title={t("settings.account.signOutUnavailable")}
            className="webui-mavis-button webui-mavis-button-gray"
          >
            {t("settings.account.signOut")}
          </button>
        </div>
      </div>
    </section>
  );
}
