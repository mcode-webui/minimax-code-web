"use client";

/**
 * Desktop notifications — the one mount point (SB-9).
 *
 * Mounted once at the root of the page, exactly like `AppearanceSync`, and for
 * the same reason: the three triggers are spread across three different
 * subscriptions (the state stream, the alerts stream, and the `Notification`
 * API itself), and the only place that can see all three at once is the root.
 *
 * This component owns no policy. Every decision — which events notify, how a
 * failure and its completion collapse into one notification, whether the user
 * is already looking at the tab — lives in `lib/desktop-notify.ts` as pure
 * functions. Here it only:
 *
 *   1. reads the three subscriptions,
 *   2. folds them into one `advanceDesktopNotifyCursor` call, and
 *   3. renders nothing.
 *
 * Folding all three into ONE call per effect pass is deliberate. Folding them
 * separately would let two decisions be raised in the same pass and one of them
 * would be lost, which is how a failed turn ends up saying "done".
 */

import { useEffect, useRef } from "react";

import { useSessionContext } from "@/lib/store";
import { useAlerts } from "@/lib/alerts";
import {
  advanceDesktopNotifyCursor,
  showDesktopNotification,
  INITIAL_NOTIFY_CURSOR,
  type DesktopNotifyCursor,
} from "@/lib/desktop-notify";
import { useLocale } from "@/lib/use-locale";

export function DesktopNotifySync(): null {
  const { state, authorize } = useSessionContext();
  const { alerts, historySealed } = useAlerts();
  const { t } = useLocale();
  // The cursor is a fold, not render state: it must survive re-renders without
  // being a reason to re-render. `useRef` rather than `useState` for exactly
  // that reason — writing it never re-runs the effect that consumes it.
  const cursorRef = useRef<DesktopNotifyCursor>(INITIAL_NOTIFY_CURSOR);

  useEffect(() => {
    const advanced = advanceDesktopNotifyCursor(cursorRef.current, {
      runningActive: state ? state.running.active : null,
      sessionId: state?.sessionId ?? null,
      authorizeRequestId: authorize?.requestId ?? null,
      alerts,
      alertsHistorySealed: historySealed,
      nowMs: Date.now(),
    });
    cursorRef.current = advanced.cursor;
    const decision = advanced.decision;
    if (decision.kind === "none") return;

    if (decision.kind === "turn-complete") {
      showDesktopNotification({
        kind: "turn-complete",
        title: t("notify.turnComplete.title"),
        body: t("notify.turnComplete.body"),
        sessionId: decision.sessionId,
      });
      return;
    }
    if (decision.kind === "needs-confirmation") {
      showDesktopNotification({
        kind: "needs-confirmation",
        title: t("notify.needsConfirmation.title"),
        body: t("notify.needsConfirmation.body"),
        sessionId: decision.sessionId,
      });
      return;
    }
    showDesktopNotification({
      kind: "turn-error",
      title: t("notify.turnError.title"),
      body: decision.message || t("notify.turnError.body"),
      sessionId: decision.sessionId,
    });
  }, [state, authorize, alerts, historySealed, t]);

  return null;
}
