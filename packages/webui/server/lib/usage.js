// webui/server/lib/usage.js
// Plan-level quota (the Token Plan's 5h and weekly windows) for the usage
// popover and the /usage slash command.
//
// The engine holds the credential, so it is the only side that may call MiniMax's
// quota endpoint. What it learned is available to ACP clients as the extension
// method `mcode/account/status` (packages/tui/src/acp/extensions.ts), whose
// projection carries the plan tier plus each window's remaining percentage and
// reset instant. webui asks the engine instead of keeping a Subscription Key of
// its own: storing the user's credential in order to repeat a call the engine
// already makes is a second copy of the secret, and buys no capability the engine
// lacks.
//
// Session-level token usage is not this module's concern — that lives in
// `mavis-usage.js`, which the chat flow reads once a mcode session exists. The
// `session*` fields of `cs.usage` belong to the chat flow (`mcode-acp.js`
// accumulates them per turn), so nothing here resets them.

import { getAccountStatus } from "./mcode-rpc.js";
import { pushStateFor } from "./state-bus.js";

// A window arrives as `{ remainingPercent?, resetAtMs?, unlimited }`. The
// engine's own status bar reads one the same way (packages/tui/src/tui/shell/
// chrome.ts `quotaAlertWindow`): `unlimited`, and a percentage that is not a
// finite number, both mean "no figure to show". Matching the engine avoids
// drawing a gauge for a window the engine itself would not report.
function windowPercent(win) {
  if (!win || win.unlimited === true) return null;
  const pct = win.remainingPercent;
  return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}

// `resetAtMs` is absolute epoch milliseconds. The snapshot and the popover both
// read unix seconds, so convert here once.
function windowResetSeconds(win) {
  if (!win || typeof win.resetAtMs !== "number" || !Number.isFinite(win.resetAtMs)) {
    return null;
  }
  return Math.floor(win.resetAtMs / 1000);
}

/**
 * Copy the engine's account projection into `cs.usage`.
 *
 * `tokenPlanQuotaState` is the engine's own verdict on whether it could read the
 * plan, so it decides whether the figures below are real: only "available" means
 * there is a live quota reading behind them. `hidden` follows that verdict, so a
 * not-subscribed or unreachable account records no forecast history row instead
 * of a row full of nulls.
 *
 * `plan` / `planExpiresAtMs` / `creditBalance` are display-only — nothing renders
 * them today — and keep the engine's own field names and types, so a value is
 * never re-interpreted on the way to the browser.
 */
export function applyAccountQuota(account, cs) {
  const quota = (account && account.quota) || {};
  const plan = (account && account.tokenPlan) || {};
  const fiveHourPercent = windowPercent(quota.fiveHour);
  const weeklyPercent = windowPercent(quota.weekly);

  cs.usage.plan = typeof plan.tier === "string" ? plan.tier : null;
  cs.usage.planExpiresAtMs =
    typeof plan.expiresAtMs === "number" && Number.isFinite(plan.expiresAtMs)
      ? plan.expiresAtMs
      : null;
  cs.usage.creditBalance =
    typeof plan.creditBalance === "string" ? plan.creditBalance : null;
  cs.usage.fiveHourPercent = fiveHourPercent;
  // `weekly` stays a "%"-suffixed string: the long-standing snapshot shape
  // carries it that way and quota-forecast.js parses it back out.
  cs.usage.weekly = weeklyPercent === null ? null : `${weeklyPercent}%`;
  cs.usage.fiveHourReset = windowResetSeconds(quota.fiveHour);
  cs.usage.weeklyReset = windowResetSeconds(quota.weekly);
  cs.usage.raw = null;
  cs.usage.hidden = (account && account.tokenPlanQuotaState) !== "available";
}

/**
 * The popover's payload.
 *
 * `remaining` is present only when the engine reported a figure, so the client
 * can tell "no gauge to draw" from "0% left" — an `ok: true` payload without
 * `remaining` renders the popover's unavailable state. `resetAt` and
 * `weeklyResetAt` are unix seconds; the client normalizes either unit.
 */
export function quotaSnapshot(cs, extra = {}) {
  const u = (cs && cs.usage) || {};
  const weeklyRemaining = typeof u.weekly === "string" ? parseFloat(u.weekly) : NaN;
  return {
    ok: true,
    source: "acp",
    ...(typeof u.fiveHourPercent === "number" ? { remaining: u.fiveHourPercent } : {}),
    ...(typeof u.fiveHourReset === "number" ? { resetAt: u.fiveHourReset } : {}),
    ...(typeof u.weeklyReset === "number" ? { weeklyResetAt: u.weeklyReset } : {}),
    ...(Number.isFinite(weeklyRemaining) ? { weeklyRemaining } : {}),
    fetchedAt: u.fetchedAt ?? null,
    ...extra,
  };
}

/**
 * Refresh `cs.usage` from the engine and push the new state to subscribers.
 *
 * Called by POST /api/usage, /api/usage-trigger and the /usage slash command.
 * Returns the popover payload, so a caller that answers over HTTP can use the
 * figures it just fetched instead of a second read.
 *
 * A failure is reported in the payload and left in `cs.usage.error` rather than
 * thrown: the popover shows a "load failed" line, and the route's status stays
 * 200 because the request itself succeeded.
 */
export async function runUsageQuery(cs, cid) {
  const r = await getAccountStatus(cs && cs.mcodeSessionId);
  cs.usage.fetchedAt = Date.now();
  if (!r.ok) {
    cs.usage.error = r.error;
    cs.usage.hidden = true;
    pushStateFor(cid);
    return {
      ok: false,
      source: "acp",
      error: r.error,
      fetchedAt: cs.usage.fetchedAt,
    };
  }
  applyAccountQuota(r.data, cs);
  cs.usage.error = null;
  pushStateFor(cid);
  return quotaSnapshot(cs);
}
