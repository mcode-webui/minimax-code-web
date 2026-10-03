"use client";

/**
 * Desktop notifications (SB-9) — the decision core plus a thin browser adapter.
 *
 * The split is deliberate and is the whole design: every rule about *whether*
 * to notify is a pure function over four facts, so the policy is testable
 * without a DOM, a permission prompt, or a clock. The browser calls
 * (`Notification`, `document.visibilityState`, `window.focus`) live at the
 * edges and nowhere else.
 *
 * Three triggers, and why exactly these three:
 *
 *   `turn-complete`      the settle of `running.active` (true → false).
 *   `needs-confirmation` a `needs_authorization` request awaiting an answer.
 *   `turn-error`         an `error`-level anomaly on the alerts stream.
 *
 * All three already arrive on streams this client subscribes to, so nothing
 * here invents a new server channel.
 *
 * The one rule that applies to all three is the noise floor: a notification
 * that duplicates something already on screen is noise, so `visible` blocks
 * every kind. For `turn-complete` the finished conversation is in the tab the
 * user is looking at; for `needs-confirmation` the blocking modal is in front
 * of them; for `turn-error` the alerts badge and the action-error banner are
 * both already raised. The desktop reference has no equivalent rule because it
 * has no page to be looking at.
 */

import { readDesktopNotifications } from "./settings-local";

/** What happened. Each maps to one of the three streams the client reads. */
export type DesktopNotifyKind = "turn-complete" | "needs-confirmation" | "turn-error";

/**
 * The browser's notification capability as this page sees it.
 *
 * `"unsupported"` is a first-class member, not an error: a browser without the
 * `Notification` constructor (or a non-secure origin, where the constructor is
 * absent) must be reported as "cannot do this" rather than crashing a module
 * that the settings page imports unconditionally.
 */
export type DesktopNotifyPermission = NotificationPermission | "unsupported";

/** The four facts the decision is made from. */
export interface DesktopNotifyFacts {
  /** The settings-page switch, read from `localStorage`. */
  readonly enabled: boolean;
  /** The browser's live permission — never persisted, never assumed. */
  readonly permission: DesktopNotifyPermission;
  /** `document.visibilityState === "visible"`. */
  readonly visible: boolean;
}

/**
 * Should this event raise a notification?
 *
 * Order matters only for readability; the gates are independent. `unsupported`
 * and a non-`granted` permission both mean the constructor will not show
 * anything, and asking for one anyway would surface a silent no-op as a
 * working feature.
 */
export function shouldShowDesktopNotification(
  kind: DesktopNotifyKind,
  facts: DesktopNotifyFacts,
): boolean {
  if (facts.permission === "unsupported") return false;
  if (facts.permission !== "granted") return false;
  if (!facts.enabled) return false;
  // The noise floor, shared by all three kinds — see the module docblock.
  if (facts.visible) return false;
  // `kind` is carried but not read, and that is the point of carrying it. It
  // is what lets a test assert the shared rule PER KIND rather than once for
  // an unnamed event, and it is the seam a genuine per-kind rule (a rate limit
  // on repeated failures, say) belongs in. Reading it into the decision today
  // would be a fabricated branch.
  void kind;
  return true;
}

/** One notification, ready to hand to the browser. */
export interface DesktopNotificationInput {
  readonly kind: DesktopNotifyKind;
  readonly title: string;
  readonly body: string;
  /**
   * The session the notification is about. Carried on the click path so the
   * user lands on the conversation the notification refers to, not on whatever
   * the page happened to be showing.
   */
  readonly sessionId: string | null;
}

/**
 * A failed turn must raise exactly ONE notification, not two.
 *
 * The error reaches this client over a different connection than the state
 * stream (the alerts SSE vs. the events SSE), and the server pushes the alert
 * just before the broadcast that settles the turn — but nothing orders two
 * HTTP responses. So the two can be seen in either order, and a failed turn
 * that raised both would say "done" and "failed" about the same turn.
 *
 * The rule is a bounded coalescing window rather than an ordering assumption:
 * an error notification is remembered against its session, and a turn
 * completion on that session inside the window is swallowed. The window is
 * short on purpose — it exists to cover the delivery skew between two local
 * streams, not to suppress a legitimate later notification. Entries outside
 * the window are stale and are ignored, so an error with no completion after
 * it cannot suppress an unrelated turn an hour later.
 */
export const TURN_ERROR_COALESCE_MS = 5_000;

/** The signalling cursor the sync component threads through each observation. */
export interface DesktopNotifyCursor {
  /** The last observed `running.active`. `null` before the first state. */
  readonly runningActive: boolean | null;
  /** The last announced `authorize.requestId`; guards against a re-sent frame. */
  readonly announcedRequestId: string | null;
  /** Alert ids already accounted for. */
  readonly seenAlertIds: ReadonlySet<string>;
  /**
   * `false` until the first NON-EMPTY alerts snapshot is absorbed. The stream
   * opens with a ring-buffer snapshot of everything that happened before this
   * page loaded, and none of it is news the user is waiting on — notifying for
   * it would fire up to 200 notifications for a tab that was just opened.
   */
  readonly alertsSeeded: boolean;
  /** sessionId → when its error notification was raised. */
  readonly lastErrorAt: ReadonlyMap<string, number>;
}

export const INITIAL_NOTIFY_CURSOR: DesktopNotifyCursor = {
  runningActive: null,
  announcedRequestId: null,
  seenAlertIds: new Set<string>(),
  alertsSeeded: false,
  lastErrorAt: new Map<string, number>(),
};

/** What the policy says to raise, given the cursor and the fresh observations. */
export type DesktopNotifyDecision =
  | { readonly kind: "none" }
  | { readonly kind: "turn-complete"; readonly sessionId: string | null }
  | {
      readonly kind: "needs-confirmation";
      readonly sessionId: string | null;
    }
  | {
      readonly kind: "turn-error";
      readonly sessionId: string | null;
      readonly message: string;
    };

/** One observation batch: what changed since the previous cursor. */
export interface DesktopNotifyObservation {
  /** `running.active` from the newest state snapshot, or `null` for none. */
  readonly runningActive: boolean | null;
  /** The session the newest snapshot belongs to, or `null`. */
  readonly sessionId: string | null;
  /** The pending authorize request's id, or `null` when there is none. */
  readonly authorizeRequestId: string | null;
  /** The alerts ring buffer as it stands now (newest first). */
  readonly alerts: readonly {
    id: string;
    level: string;
    msg: string;
    sessionId: string | null;
  }[];
  /**
   * Whether the alerts stream has delivered its opening `snapshot` frame
   * (`lib/alerts.ts#historySealed`). Until it has, the buffer is pre-load
   * history and none of it is news the user is waiting on.
   */
  readonly alertsHistorySealed: boolean;
  /** `Date.now()`-shaped; injected so the window is testable without a clock. */
  readonly nowMs: number;
}

const NO_DECISION: DesktopNotifyDecision = { kind: "none" };

/**
 * Advance the cursor over one observation batch and say what to raise.
 *
 * Errors win over completions inside the coalescing window, so a failed turn
 * produces one notification and a successful one produces the completion.
 * Returns the new cursor alongside, because the caller must carry the seen-set
 * and the running latch forward — this is a fold, not a query.
 */
export function advanceDesktopNotifyCursor(
  cursor: DesktopNotifyCursor,
  observation: DesktopNotifyObservation,
): { cursor: DesktopNotifyCursor; decision: DesktopNotifyDecision } {
  const seenAlertIds = new Set(cursor.seenAlertIds);
  const lastErrorAt = new Map(cursor.lastErrorAt);
  let decision: DesktopNotifyDecision = NO_DECISION;

  // --- errors, off the alerts stream -----------------------------------------
  const incoming = observation.alerts.filter((alert) => !seenAlertIds.has(alert.id));
  for (const alert of incoming) seenAlertIds.add(alert.id);
  // The stream's opening `snapshot` frame is pre-load history: its alerts are
  // marked seen so they can never be announced, and they are not announced now
  // either. Told by the stream's own frame kind, not guessed from emptiness —
  // an empty history and an unwatched first failure look identical in a list.
  const isHistoryBatch = !cursor.alertsSeeded && observation.alertsHistorySealed;
  const alertsSeeded = cursor.alertsSeeded || observation.alertsHistorySealed;
  const freshErrors = isHistoryBatch
    ? []
    : incoming.filter((alert) => alert.level === "error");

  if (freshErrors.length > 0) {
    // The ring buffer is newest-first, so the first match is the latest failure
    // when several arrived in one batch.
    const latest = freshErrors[0];
    if (!latest) {
      // Defensive: `incoming` is empty whenever `freshErrors` is, so this cannot
      // be reached; the narrowing keeps the rest of the function total.
    } else {
      const sessionId = latest.sessionId ?? observation.sessionId;
      if (sessionId !== null) lastErrorAt.set(sessionId, observation.nowMs);
      decision = { kind: "turn-error", sessionId, message: latest.msg };
    }
  }

  // --- a blocking decision prompt, off the authorize request -----------------
  let announcedRequestId = cursor.announcedRequestId;
  if (observation.authorizeRequestId !== null) {
    // A re-sent frame for the same request must not notify twice.
    if (observation.authorizeRequestId !== cursor.announcedRequestId) {
      announcedRequestId = observation.authorizeRequestId;
      decision = { kind: "needs-confirmation", sessionId: observation.sessionId };
    }
  } else {
    announcedRequestId = null;
  }

  // --- completions, off the running latch ------------------------------------
  const settled = cursor.runningActive === true && observation.runningActive === false;
  if (settled && decision.kind === "none") {
    const sessionId = observation.sessionId;
    const errorAt = sessionId === null ? undefined : lastErrorAt.get(sessionId);
    const withinWindow =
      errorAt !== undefined && observation.nowMs - errorAt <= TURN_ERROR_COALESCE_MS;
    if (withinWindow) {
      // Consumed: this completion is the failed turn's own and has already been
      // accounted for. Leaving the entry would let it suppress a later,
      // unrelated completion on the same session.
      if (sessionId !== null) lastErrorAt.delete(sessionId);
    } else {
      decision = { kind: "turn-complete", sessionId };
    }
  }

  return {
    cursor: {
      runningActive: observation.runningActive,
      announcedRequestId,
      seenAlertIds,
      alertsSeeded,
      lastErrorAt,
    },
    decision,
  };
}

/**
 * Brings a session into view. Registered once by the page root, which is the
 * only place that knows how a session switch is performed; this module must
 * not reach into `lib/api` or the tab strip to do it itself.
 */
export type DesktopNotifyFocusHandler = (sessionId: string | null) => void;

let focusHandler: DesktopNotifyFocusHandler | null = null;

/** Register the click target's behaviour; returns the unsubscribe. The last
 *  registration wins, and `null` clears it — a page that unmounts must not
 *  leave a stale closure holding its own state alive. */
export function registerDesktopNotifyFocusHandler(
  handler: DesktopNotifyFocusHandler | null,
): () => void {
  focusHandler = handler;
  return () => {
    if (focusHandler === handler) focusHandler = null;
  };
}

/** Test-only handle: read the registered handler without a browser. */
export function __testDesktopNotifyFocusHandler(): DesktopNotifyFocusHandler | null {
  return focusHandler;
}

function notificationConstructor(): typeof Notification | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as { Notification?: typeof Notification }).Notification;
  return typeof ctor === "function" ? ctor : null;
}

/** The browser's live permission, or `"unsupported"`. Never throws. */
export function desktopNotifyPermission(): DesktopNotifyPermission {
  const ctor = notificationConstructor();
  if (!ctor) return "unsupported";
  try {
    return ctor.permission;
  } catch {
    return "unsupported";
  }
}

/**
 * Ask the browser for permission.
 *
 * A `requestPermission()` that rejects (older Safari returns a promise, but a
 * hostile or locked-down embedder can throw) is reported as `"denied"`, not as
 * a rejection: the caller's only question is "may I show notifications", and an
 * exception carries no better answer than a refusal. This function never
 * rejects — a settings toggle must not be able to throw.
 */
export async function requestDesktopNotifyPermission(): Promise<DesktopNotifyPermission> {
  const ctor = notificationConstructor();
  if (!ctor || typeof ctor.requestPermission !== "function") return "unsupported";
  try {
    const result = await ctor.requestPermission();
    return result === "granted" || result === "denied" ? result : "default";
  } catch {
    return "denied";
  }
}

/** Is the page currently in front of the user? `true` when there is no
 *  `document` to ask (SSR pass) is NOT claimed — without a document the answer
 *  is unknown, and claiming "visible" would suppress every notification. */
function pageIsVisible(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible";
}

/**
 * Show one notification, if the policy allows it.
 *
 * Returns whether a notification was actually constructed. The two ways it can
 * return `false` — policy declined, or the constructor threw — are both "no
 * notification appeared", which is all a caller can act on. A constructor that
 * throws is swallowed rather than rethrown for the same reason
 * `requestDesktopNotifyPermission` swallows: a desktop convenience must not be
 * able to take down a turn.
 */
export function showDesktopNotification(input: DesktopNotificationInput): boolean {
  const ctor = notificationConstructor();
  if (ctor === null) return false;
  if (
    !shouldShowDesktopNotification(input.kind, {
      enabled: readDesktopNotifications(),
      permission: desktopNotifyPermission(),
      visible: pageIsVisible(),
    })
  ) {
    return false;
  }
  try {
    const notification = new ctor(input.title, {
      body: input.body,
      // One tag per kind per session: a repeated trigger replaces its own
      // notification instead of stacking a second copy of the same news.
      tag: `${input.kind}:${input.sessionId ?? "-"}`,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Focusing is a request, not a guarantee (and is refused outright
        // outside a user gesture on some browsers). The session switch that
        // follows is the part the user can actually see.
      }
      focusHandler?.(input.sessionId);
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
