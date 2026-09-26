// webapp/test/store-revision.test.ts
// Unit tests for ticket 08 — client-side revision guard in lib/store.tsx.
//
// The store consumes the server's SSE snapshots and applies them
// verbatim to its `state` field. The set-model SSE race (ticket 08)
// saw wire frames alternate between two encodings
// (`[GLM-5.3, M3, GLM-5.3, ...]`) — every snapshot the React store
// applied was correct-by-itself, but the LAST one to arrive won,
// regardless of which was strictly newer. The store now tracks the
// per-cid monotonic revision the server stamps on every snapshot and
// drops any frame whose revision is `<=` the last-applied value.
//
// Test strategy: `lib/store.tsx` exposes a pair of test-only helpers
// (`__testApplyAction`, `__testSnapshot`, `__testReset`) that drive
// the same reducer the EventSource dispatcher uses. They run in pure
// mode without React / EventSource / DOM, so these tests skip the
// usual webapp heavy machinery (avatars, sidebars) and pin the
// guard's invariants directly.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as store from "../lib/store";
import { parseSseFrame } from "../lib/sse";

const { __testApplyAction, __testSnapshot, __testReset } = store as unknown as {
  __testApplyAction: (
    action: ReturnType<typeof parseSseFrame> | { kind: "connected"; value: boolean },
  ) => unknown;
  __testSnapshot: () => {
    state: unknown;
    stateRevision: number;
    connected: boolean;
    error: string | null;
  };
  __testReset: () => void;
};

function parseState(revision: number, modelName: string, extras: Record<string, unknown> = {}) {
  return parseSseFrame(
    "",
    JSON.stringify({
      version: "1.0",
      chat: [],
      model: { name: modelName },
      revision,
      ...extras,
    }),
  );
}

beforeEach(() => {
  __testReset();
});

// ============================================================
// First-frame bootstrap
// ============================================================

describe("store revision guard — first-frame bootstrap", () => {
  test("the very first snapshot applies (revision ≥ 0 wins against -1)", () => {
    const action = parseState(1, "GLM-5.3");
    __testApplyAction(action);
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 1);
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "GLM-5.3");
  });

  test("a snapshot with no revision applies (defensive — does not advance the guard)", () => {
    const action = parseSseFrame("", JSON.stringify({ version: "1.0", model: { name: "v0" } }));
    __testApplyAction(action);
    // Without a `revision` the snapshot still applies but the guard
    // does not advance — every subsequent frame is judged against
    // stateRevision=-1 and accepted. This is the static-source
    // tripwire for "I forgot to stamp a revision" regressions.
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, -1,
      "no-revision frames do NOT advance the guard");
  });
});

// ============================================================
// Strict monotonicity
// ============================================================

describe("store revision guard — strict monotonicity", () => {
  test("a strictly greater revision always applies and replaces the state", () => {
    __testApplyAction(parseState(10, "v1"));
    __testApplyAction(parseState(11, "v2"));
    __testApplyAction(parseState(12, "v3"));
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 12);
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "v3",
      "the LAST applied revision is reflected in the state object");
  });

  test("an EQUAL revision is dropped (no rewind, no double-apply)", () => {
    __testApplyAction(parseState(10, "v1"));
    __testApplyAction(parseState(10, "v1-different-but-same-rev"));
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 10);
    // First payload's value stays (the equal-rev frame never
    // touched `state`).
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "v1");
  });

  test("a LOWER revision is dropped — the rendered state does NOT rewind", () => {
    __testApplyAction(parseState(20, "newer"));
    __testApplyAction(parseState(10, "STALE-older"));
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 20);
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "newer",
      "a stale frame at revision 10 must not rewind the UI back to its payload");
  });

  test("wire reordering: a low-revision frame arriving after a high-rev frame is dropped", () => {
    // Simulates a server-side coalesce-window write order in which a
    // pre-existing frame at revision 11 arrives AFTER the revision
    // 12 frame has already been applied.
    __testApplyAction(parseState(11, "engine-wire-form"));
    __testApplyAction(parseState(12, "user-friendly-form"));
    __testApplyAction(parseState(11, "reordered-stale"));
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 12);
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "user-friendly-form",
      "reordered stale frame does NOT clobber the newer user pick");
  });
});

// ============================================================
// The actual ticket 07 dev reproduction — the `[GLM-5.3, M3,
// GLM-5.3]` alternation. With the guard, the LAST revision wins,
// but earlier mid-sequence alternations stop the chip from
// flickering because the same revision's payload is the only one
// that applies. (Pre-fix: every alternating frame applied verbatim,
// and the LAST arrival won; the user-visible oscillation was the
// symptom.)
// ============================================================

describe("store revision guard — set-model race shape", () => {
  test("three monotonic revisions [10, 11, 12] leave the state at the highest", () => {
    __testApplyAction(parseState(10, "GLM-5.3"));
    __testApplyAction(parseState(11, "m:minimax:GLM-5.3:u"));
    __testApplyAction(parseState(12, "minimax_api/GLM-5.3"));
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 12);
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "minimax_api/GLM-5.3");
  });

  test("a late duplicate revision is dropped (same chip, no flicker)", () => {
    __testApplyAction(parseState(11, "GLM-5.3"));
    __testApplyAction(parseState(11, "m:minimax:GLM-5.3:u"));
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 11);
    const state = snap.state as { model: { name: string } };
    assert.equal(state.model.name, "GLM-5.3",
      "the first frame at revision 11 wins; subsequent frames at the SAME revision are dropped");
  });
});

// ============================================================
// Other action kinds remain unaffected by the revision guard.
// ============================================================

describe("store revision guard — non-state actions are unaffected", () => {
  test("authorize frames still install the request", () => {
    __testApplyAction({
      kind: "authorize",
      request: {
        requestId: "r1",
        action: "bash",
        ctx: {},
        expiresAt: 1,
      },
    });
    const snap = __testSnapshot();
    const auth = (snap as unknown as { authorize: { requestId: string } | null }).authorize;
    assert.ok(auth);
    assert.equal(auth.requestId, "r1");
  });

  test("provider-updated bumps providersRevision independently", () => {
    __testApplyAction({ kind: "providers-updated", providers: [] });
    __testApplyAction({ kind: "providers-updated", providers: [] });
    const snap = __testSnapshot();
    const pr = (snap as unknown as { providersRevision: number }).providersRevision;
    assert.equal(pr, 2);
  });

  test("malformed frames do not disturb the revision guard", () => {
    __testApplyAction(parseState(5, "valid"));
    __testApplyAction({ kind: "malformed", event: "message", detail: "bad" });
    const snap = __testSnapshot();
    assert.equal(snap.stateRevision, 5,
      "malformed frames are reported via `error`, not by advancing or rewinding the guard");
    assert.ok(snap.error && snap.error.includes("malformed"));
  });
});

// ============================================================
// parseSseFrame: the wire-shape of state frames the server emits
// after ticket 08 — every snapshot has a numeric `revision`.
// ============================================================

describe("parseSseFrame — server-stamped revision tag", () => {
  test("a snapshot body with a numeric revision classifies as state", () => {
    const action = parseSseFrame(
      "",
      JSON.stringify({ version: "1.0", model: { name: "x" }, revision: 7 }),
    );
    assert.equal(action.kind, "state");
    if (action.kind === "state") {
      assert.equal(action.state.revision, 7);
    }
  });
});
