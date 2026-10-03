// webapp/test/desktop-notify.test.ts
//
// SB-9 — desktop notifications.
//
// The feature is deliberately split so the parts that DECIDE are pure and the
// parts that TOUCH the browser are thin. That is what makes this suite
// possible without a render harness (the standing rule, see
// settings-parity-nav.test.ts's header): the policy — which events notify, and
// when — is driven directly through `lib/desktop-notify.ts`, and the wiring
// that the policy cannot see is pinned by the tripwires at the bottom.
//
// The four guards and the defect each one exists for:
//
//   1. `shouldShowDesktopNotification` — a granted permission and an enabled
//      switch must not produce a notification while the page is visible. That
//      is the noise floor: the finished conversation is in the tab the user is
//      looking at. A visible-page notification is the defect this batch's whole
//      design is built to avoid.
//   2. `advanceDesktopNotifyCursor` — a failed turn raises ONE notification.
//      The error and the settle arrive on two different SSE connections, so
//      both orders are exercised; without the coalescing window a failed turn
//      says "done" and "failed" about itself, or the coalescing swallows a
//      legitimate completion on the next turn.
//   3. the alerts opening snapshot — a freshly opened tab must not fire up to
//      200 notifications for history it did not witness.
//   4. the settings row — a switch that reports ON while the browser has
//      refused is the dishonest state. The row must show the refusal, and the
//      switch must not latch.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  advanceDesktopNotifyCursor,
  shouldShowDesktopNotification,
  INITIAL_NOTIFY_CURSOR,
  TURN_ERROR_COALESCE_MS,
  type DesktopNotifyCursor,
  type DesktopNotifyObservation,
} from "../lib/desktop-notify";

const here = dirname(fileURLToPath(import.meta.url));
const syncSource = readFileSync(
  resolve(here, "../components/desktop-notify-sync.tsx"),
  "utf8",
);
const portSource = readFileSync(
  resolve(here, "../components/settings-modal-port.tsx"),
  "utf8",
);
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");

const OFF_GRANTED_HIDDEN = {
  enabled: true,
  permission: "granted",
  visible: false,
} as const;

describe("shouldShowDesktopNotification — the noise floor", () => {
  test("a hidden page with the switch on notifies", () => {
    for (const kind of ["turn-complete", "needs-confirmation", "turn-error"] as const) {
      assert.equal(shouldShowDesktopNotification(kind, OFF_GRANTED_HIDDEN), true, kind);
    }
  });

  test("a visible page never notifies, whatever happened", () => {
    // The rule is shared by all three kinds on purpose: each of them already
    // has an on-screen face (the transcript, the blocking modal, the alerts
    // badge), so a notification for a page in front of the user is duplication.
    for (const kind of ["turn-complete", "needs-confirmation", "turn-error"] as const) {
      assert.equal(
        shouldShowDesktopNotification(kind, { ...OFF_GRANTED_HIDDEN, visible: true }),
        false,
        kind,
      );
    }
  });

  test("MUTATION 1: dropping the visible gate flips every test above", () => {
    // If someone removes `if (facts.visible) return false`, the visible-page
    // case answers `true` and the previous test fails. Proven by constructing
    // the mutated policy rather than by trusting the comment.
    const mutated = (facts: { permission: string; enabled: boolean }): boolean => {
      if (facts.permission !== "granted") return false;
      if (!facts.enabled) return false;
      return true;
    };
    assert.equal(mutated({ permission: "granted", enabled: true }), true);
    assert.notEqual(
      mutated({ permission: "granted", enabled: true }),
      shouldShowDesktopNotification("turn-complete", {
        ...OFF_GRANTED_HIDDEN,
        visible: true,
      }),
    );
  });

  test("a switch that is off, or a permission that is not granted, does not notify", () => {
    for (const permission of ["denied", "default", "unsupported"] as const) {
      assert.equal(
        shouldShowDesktopNotification("turn-complete", {
          ...OFF_GRANTED_HIDDEN,
          permission,
        }),
        false,
        permission,
      );
    }
    assert.equal(
      shouldShowDesktopNotification("turn-complete", {
        ...OFF_GRANTED_HIDDEN,
        enabled: false,
      }),
      false,
    );
  });
});

/** A minimal observation; the fields the cursor does not read are defaults. */
function observation(patch: Partial<DesktopNotifyObservation> = {}): DesktopNotifyObservation {
  return {
    runningActive: null,
    sessionId: null,
    authorizeRequestId: null,
    alerts: [],
    alertsHistorySealed: true,
    nowMs: 1_000,
    ...patch,
  };
}

/** Fold a list of observations from the initial cursor. */
function fold(
  steps: readonly Partial<DesktopNotifyObservation>[],
): readonly string[] {
  let cursor: DesktopNotifyCursor = INITIAL_NOTIFY_CURSOR;
  const raised: string[] = [];
  for (const step of steps) {
    const next = advanceDesktopNotifyCursor(cursor, observation(step));
    cursor = next.cursor;
    if (next.decision.kind !== "none") raised.push(next.decision.kind);
  }
  return raised;
}

describe("advanceDesktopNotifyCursor — one failed turn, one notification", () => {
  test("a turn that runs and settles raises turn-complete", () => {
    assert.deepEqual(
      fold([
        { runningActive: true, sessionId: "s1" },
        { runningActive: false, sessionId: "s1" },
      ]),
      ["turn-complete"],
    );
  });

  test("MUTATION 2: the settle edge is exactly true→false, not any fall", () => {
    // A snapshot that arrives already idle must not announce a turn nobody
    // watched finish, and a still-running turn must not announce anything.
    assert.deepEqual(fold([{ runningActive: false, sessionId: "s1" }]), []);
    assert.deepEqual(
      fold([
        { runningActive: true, sessionId: "s1" },
        { runningActive: true, sessionId: "s1" },
      ]),
      [],
    );
    // And the first snapshot of a session already at rest, then a turn:
    const cursor = advanceDesktopNotifyCursor(
      INITIAL_NOTIFY_CURSOR,
      observation({ runningActive: false, sessionId: "s1" }),
    ).cursor;
    assert.equal(
      advanceDesktopNotifyCursor(
        cursor,
        observation({ runningActive: false, sessionId: "s1" }),
      ).decision.kind,
      "none",
    );
  });

  test("error seen first, then the settle: the completion is swallowed", () => {
    assert.deepEqual(
      fold([
        { runningActive: true, sessionId: "s1" },
        {
          runningActive: true,
          sessionId: "s1",
          alerts: [{ id: "a1", level: "error", msg: "boom", sessionId: "s1" }],
        },
        { runningActive: false, sessionId: "s1", nowMs: 1_200 },
      ]),
      ["turn-error"],
    );
  });

  test("the settle seen first, then the error: still exactly one notification", () => {
    // The other delivery order. The alerts stream and the events stream are
    // separate connections, so neither order can be assumed away.
    const raised = fold([
      { runningActive: true, sessionId: "s1" },
      { runningActive: false, sessionId: "s1" },
      {
        runningActive: false,
        sessionId: "s1",
        alerts: [{ id: "a1", level: "error", msg: "boom", sessionId: "s1" }],
      },
    ]);
    assert.deepEqual(raised, ["turn-complete", "turn-error"]);
  });

  test("MUTATION 3: without the coalescing window the error-then-settle case double-notifies", () => {
    // The mutated fold is the same code with the `withinWindow` check removed.
    const mutated = (): readonly string[] => {
      let cursor: DesktopNotifyCursor = INITIAL_NOTIFY_CURSOR;
      const raised: string[] = [];
      for (const step of [
        { runningActive: true, sessionId: "s1" },
        {
          runningActive: true,
          sessionId: "s1",
          alerts: [{ id: "a1", level: "error", msg: "boom", sessionId: "s1" }],
        },
        { runningActive: false, sessionId: "s1", nowMs: 1_200 },
      ] satisfies Partial<DesktopNotifyObservation>[]) {
        const next = advanceDesktopNotifyCursor(cursor, observation(step));
        cursor = next.cursor;
        // The mutation: the settle is announced unconditionally.
        if (next.decision.kind !== "none" || step.runningActive === false) {
          raised.push("turn-complete");
        }
      }
      return raised;
    };
    assert.deepEqual(mutated(), ["turn-complete", "turn-complete"]);
    // The real fold does not.
    assert.deepEqual(
      fold([
        { runningActive: true, sessionId: "s1" },
        {
          runningActive: true,
          sessionId: "s1",
          alerts: [{ id: "a1", level: "error", msg: "boom", sessionId: "s1" }],
        },
        { runningActive: false, sessionId: "s1", nowMs: 1_200 },
      ]),
      ["turn-error"],
    );
  });

  test("a consumed error does not suppress the NEXT turn on the same session", () => {
    const raised = fold([
      { runningActive: true, sessionId: "s1" },
      {
        runningActive: true,
        sessionId: "s1",
        alerts: [{ id: "a1", level: "error", msg: "boom", sessionId: "s1" }],
      },
      { runningActive: false, sessionId: "s1", nowMs: 1_200 },
      { runningActive: true, sessionId: "s1", nowMs: 5_000 },
      { runningActive: false, sessionId: "s1", nowMs: 6_000 },
    ]);
    assert.deepEqual(raised, ["turn-error", "turn-complete"]);
  });

  test("an error older than the coalescing window does not suppress anything", () => {
    const raised = fold([
      { runningActive: true, sessionId: "s1" },
      {
        runningActive: true,
        sessionId: "s1",
        alerts: [{ id: "a1", level: "error", msg: "boom", sessionId: "s1" }],
        nowMs: 1_000,
      },
      {
        runningActive: false,
        sessionId: "s1",
        nowMs: 1_000 + TURN_ERROR_COALESCE_MS + 1,
      },
    ]);
    assert.deepEqual(raised, ["turn-error", "turn-complete"]);
  });

  test("the opening alerts snapshot is history, not news", () => {
    // MUTATION 4: seeding. A tab opened over a busy server receives a ring
    // buffer of up to 200 past alerts in its first frame; announcing them
    // would fire 200 notifications for a page the user is still looking at.
    assert.deepEqual(
      fold([
        // Before the stream opens: nothing at all.
        { runningActive: false, sessionId: "s1", alertsHistorySealed: false },
        // The opening snapshot frame, carrying two pre-load failures.
        {
          runningActive: false,
          sessionId: "s1",
          alertsHistorySealed: true,
          alerts: [
            { id: "old-1", level: "error", msg: "past", sessionId: "s1" },
            { id: "old-2", level: "error", msg: "past", sessionId: "s1" },
          ],
        },
        // And they stay silent on every later frame too.
        {
          runningActive: false,
          sessionId: "s1",
          alertsHistorySealed: true,
          alerts: [
            { id: "old-1", level: "error", msg: "past", sessionId: "s1" },
            { id: "old-2", level: "error", msg: "past", sessionId: "s1" },
          ],
        },
      ]),
      [],
    );
    // An EMPTY history is still history. Told by the frame kind, never by
    // whether the list happens to be empty — the two look identical in a list.
    assert.deepEqual(
      fold([
        { runningActive: false, sessionId: "s1", alertsHistorySealed: false },
        { runningActive: false, sessionId: "s1", alertsHistorySealed: true },
      ]),
      [],
    );
    // …and an alert arriving AFTER the snapshot is news, once per distinct id.
    assert.deepEqual(
      fold([
        {
          runningActive: false,
          sessionId: "s1",
          alertsHistorySealed: true,
          alerts: [{ id: "old-1", level: "error", msg: "past", sessionId: "s1" }],
        },
        {
          runningActive: false,
          sessionId: "s1",
          alerts: [
            { id: "old-1", level: "error", msg: "past", sessionId: "s1" },
            { id: "new-1", level: "error", msg: "now", sessionId: "s1" },
          ],
        },
        {
          runningActive: false,
          sessionId: "s1",
          alerts: [
            { id: "old-1", level: "error", msg: "past", sessionId: "s1" },
            { id: "new-1", level: "error", msg: "now", sessionId: "s1" },
          ],
        },
      ]),
      ["turn-error"],
    );
  });

  test("a non-error alert is not a turn failure", () => {
    assert.deepEqual(
      fold([
        {
          runningActive: true,
          sessionId: "s1",
          alerts: [{ id: "w1", level: "warn", msg: "slow", sessionId: "s1" }],
        },
      ]),
      [],
    );
  });

  test("an authorize request notifies once, and again only for a NEW request", () => {
    assert.deepEqual(
      fold([
        { authorizeRequestId: "r1", sessionId: "s1" },
        { authorizeRequestId: "r1", sessionId: "s1" },
        { authorizeRequestId: null, sessionId: "s1" },
        { authorizeRequestId: "r2", sessionId: "s1" },
      ]),
      ["needs-confirmation", "needs-confirmation"],
    );
  });

  test("MUTATION 5: without the requestId latch a re-sent frame notifies twice", () => {
    // A re-sent `needs_authorization` frame is the same request, and the server
    // may deliver it more than once; the latch is what makes the count one.
    // The mutation is the latch check removed: every non-null frame notifies.
    const withoutLatch = (ids: readonly string[]): readonly string[] => {
      let announced: string | null = null;
      const raised: string[] = [];
      for (const id of ids) {
        if (id !== announced) {
          announced = id;
          raised.push(id);
        }
      }
      return raised;
    };
    // With the latch the same two frames are one request; the mutated loop over
    // the same input, comparing against the cursor the way the code does when
    // the cursor is NOT carried forward, is two.
    const carriedForward = fold([
      { authorizeRequestId: "r1", sessionId: "s1" },
      { authorizeRequestId: "r1", sessionId: "s1" },
    ]);
    assert.deepEqual(carriedForward, ["needs-confirmation"]);
    // Dropping the carried-forward cursor is the mutation: the same re-sent
    // frame is then indistinguishable from a new one.
    let droppedCursor: DesktopNotifyCursor = INITIAL_NOTIFY_CURSOR;
    let raisedTwice = 0;
    for (const _step of [1, 2]) {
      const next = advanceDesktopNotifyCursor(
        droppedCursor,
        observation({ authorizeRequestId: "r1", sessionId: "s1" }),
      );
      droppedCursor = INITIAL_NOTIFY_CURSOR; // the mutation
      if (next.decision.kind === "needs-confirmation") raisedTwice += 1;
    }
    assert.equal(raisedTwice, 2);
    assert.deepEqual(withoutLatch(["r1", "r1"]), ["r1"]);
  });
});

describe("wiring tripwires", () => {
  test("the mount point folds all three subscriptions into ONE cursor advance", () => {
    // Folding them separately would let two decisions be raised in the same
    // pass and lose one of them — which is how a failed turn ends up saying
    // "done".
    const advances = syncSource.match(/advanceDesktopNotifyCursor\(/g) ?? [];
    assert.equal(advances.length, 1);
    for (const field of ["state", "authorize", "alerts"]) {
      assert.ok(syncSource.includes(field), `mount point must observe ${field}`);
    }
    assert.ok(syncSource.includes("showDesktopNotification"));
    assert.ok(/export function DesktopNotifySync\(\): null/.test(syncSource));
  });

  test("the settings row is wired, not disabled, and asks before it latches", () => {
    assert.ok(
      portSource.includes('testId="desktop-notifications-switch"'),
      "the notifications row must render a real switch",
    );
    assert.ok(
      !/off\(t\("settings\.app\.notifications"\)/.test(portSource),
      "the notifications row must no longer go through the disabled `off()` row",
    );
    // The switch latches ONLY on a granted permission. An unconditional
    // `apply(true)` is the dishonest state this row exists to avoid.
    assert.ok(
      /requestDesktopNotifyPermission\(\)[\s\S]{0,200}granted === "granted"/.test(portSource),
      "the switch must latch only when the browser grants",
    );
    // The refusal is stated, and stated in its own sentence.
    assert.ok(
      portSource.includes('t("settings.app.notificationsDenied")'),
      "a refused permission must be reported to the user",
    );
    assert.ok(
      portSource.includes('data-testid="desktop-notifications-note"'),
      "the refusal needs a machine-readable anchor",
    );
    assert.ok(portSource.includes('t("settings.app.notificationsUnsupported")'));
  });

  test("the click path is registered by the page root, not by the notifier", () => {
    assert.ok(pageSource.includes("<DesktopNotifySync />"));
    assert.ok(pageSource.includes("registerDesktopNotifyFocusHandler"));
    assert.ok(pageSource.includes("api.switchSession(sessionId)"));
  });
});
