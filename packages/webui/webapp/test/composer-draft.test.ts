// webapp/test/composer-draft.test.ts
//
// Contract tests for the composer's module-scope draft store
// (`lib/composer-draft.ts`), which backs the typed text, the attachment
// chips, and the send-error banner through `useSyncExternalStore`.
//
// Why this exists: page.tsx swaps the Composer between two tree positions
// the moment the first `› user line` arrives in a state push (the home
// greeting layout becomes the chat layout). That swap is a REMOUNT, and a
// `useState`-held draft died with the unmounted instance — typed text and
// the 409 session-busy error banner vanished mid-turn, so a refused send
// looked like a silent vanish. The store below is what the component reads
// instead; these tests pin the properties the composer relies on:
//
//   1. Writes are visible to a FRESH reader of the store (the remounted
//      composer) — text, attachments, and the error banner all survive.
//   2. Only an explicit success-shaped write clears the fields; nothing
//      else resets them (a state push cannot wipe the draft).
//   3. Subscribers are notified on writes and stopped by unsubscribe.
//   4. The updater form works against the CURRENT draft (no stale
//      closure over an older snapshot).
//
// webui-parity 106 (smoke-report P5) adds the isolation contract: the
// store is keyed BY SESSION, so session A's draft — text, chips, banner —
// is invisible to session B and still there when the user comes back. The
// smoke run's s28 capture (session 2's view showing session 1's draft,
// GLM chip and 409 banner) is the regression these tests fence off. The
// same ticket's P4 fix pins `unconfirmedPatchOnTurnEnd`, the pure decision
// that retires the grey unconfirmed banner when the turn it warned about
// ends.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getComposerDraft,
  resetComposerDraftForTests,
  setComposerDraft,
  subscribeComposerDraft,
  unconfirmedPatchOnTurnEnd,
  type ComposerDraft,
} from "../lib/composer-draft";

beforeEach(() => {
  resetComposerDraftForTests();
});

const S1 = "mvs_session_one";
const S2 = "mvs_session_two";

describe("composer draft store — survives the composer's remount", () => {
  test("typed text written before the 'swap' is read by a fresh reader after it", () => {
    // The composer instance that existed before the remount wrote the text.
    setComposerDraft(S1, { value: "继续这个任务" });
    // A fresh mount reads the module-scope store — the same object any
    // later instance sees, regardless of tree position.
    const afterRemount = getComposerDraft(S1);
    assert.equal(afterRemount.value, "继续这个任务");
  });

  test("send-error banner survives the same remount", () => {
    // A 409 session-busy failure wrote the banner right before the push
    // that remounts the composer.
    setComposerDraft(S1, { error: "this conversation is already running in another window" });
    assert.equal(getComposerDraft(S1).error, "this conversation is already running in another window");
  });

  test("attachment chips survive the remount too", () => {
    setComposerDraft(S1, { attachments: ["@uploads/a.txt"] });
    assert.deepEqual(getComposerDraft(S1).attachments, ["@uploads/a.txt"]);
  });

  test("nothing resets the draft implicitly — only explicit writes do", () => {
    setComposerDraft(S1, {
      value: "draft",
      error: "boom",
      attachments: ["@uploads/a.txt"],
    });
    // Simulate any number of unrelated store readers/re-renders: reading
    // the store never mutates it, and there is no reset hook on the
    // production surface.
    for (let i = 0; i < 3; i++) {
      assert.equal(getComposerDraft(S1).value, "draft");
      assert.equal(getComposerDraft(S1).error, "boom");
    }
    // The only clearing write is the composer's own success path.
    setComposerDraft(S1, { value: "", attachments: [] });
    assert.equal(getComposerDraft(S1).value, "");
    assert.deepEqual(getComposerDraft(S1).attachments, []);
    // The error banner persists until the next submit start clears it —
    // matches the pre-existing `setError(null)`-at-submit semantics.
    assert.equal(getComposerDraft(S1).error, "boom");
  });
});

describe("composer draft store — per-session isolation (webui-parity 106)", () => {
  test("session B never sees session A's typed draft", () => {
    setComposerDraft(S1, { value: "计时10s，后说hi" });
    assert.equal(getComposerDraft(S2).value, "");
    assert.equal(getComposerDraft(S2).error, null);
    assert.deepEqual(getComposerDraft(S2).attachments, []);
  });

  test("switching back restores session A's draft untouched", () => {
    setComposerDraft(S1, { value: "A 的草稿" });
    // The user works in B for a while — types, fails a send, clears.
    setComposerDraft(S2, { value: "B 的草稿" });
    setComposerDraft(S2, { error: "HTTP 500" });
    setComposerDraft(S2, { value: "", attachments: [] });
    // Back to A: the round trip must be lossless.
    assert.equal(getComposerDraft(S1).value, "A 的草稿");
    assert.equal(getComposerDraft(S1).error, null);
  });

  test("a banner written to its owning session does not paint the other one", () => {
    // The catch branch writes the banner into the DISPATCH session's box
    // even though the user is already looking at another session.
    setComposerDraft(S1, { error: "a turn is already running for this client", errorKind: "rejected" });
    assert.equal(getComposerDraft(S2).error, null);
    assert.equal(getComposerDraft(S2).errorKind, null);
    // Returning to A still shows it — the failure belongs to A.
    assert.equal(getComposerDraft(S1).error, "a turn is already running for this client");
  });

  test("an unread banner in one session survives a visit to the other", () => {
    setComposerDraft(S1, { error: "boom", errorKind: "rejected" });
    setComposerDraft(S2, { value: "unrelated work" });
    assert.equal(getComposerDraft(S1).error, "boom", "A's banner must not be cleared by visiting B");
    assert.equal(getComposerDraft(S2).value, "unrelated work");
  });

  test("the no-session bucket is its own box", () => {
    // The home screen (before the first snapshot names a session) reads
    // the "" key; its draft must not bleed into a real session either.
    setComposerDraft("", { value: "home draft" });
    assert.equal(getComposerDraft(S1).value, "");
    assert.equal(getComposerDraft("").value, "home draft");
  });

  test("the empty-session read is a stable singleton until written", () => {
    // `useSyncExternalStore` compares snapshots by reference; an unstable
    // identity for missing drafts would loop the subscription.
    assert.equal(getComposerDraft("never-written"), getComposerDraft("also-never-written"));
    const before = getComposerDraft(S1);
    setComposerDraft(S2, { value: "b" });
    assert.equal(getComposerDraft(S1), before, "writing B must not change A's snapshot identity");
  });

  test("updater form patches against the CURRENT session's draft", () => {
    setComposerDraft(S1, { attachments: ["@one"] });
    setComposerDraft(S2, { attachments: ["@b-one"] });
    setComposerDraft(S2, (current: ComposerDraft) => ({
      attachments: [...current.attachments, "@b-two"],
    }));
    assert.deepEqual(getComposerDraft(S2).attachments, ["@b-one", "@b-two"]);
    assert.deepEqual(getComposerDraft(S1).attachments, ["@one"], "A untouched by B's updater");
  });
});

describe("composer draft store — subscription", () => {
  test("listeners are notified on every write", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeComposerDraft(() => {
      seen.push(getComposerDraft(S1).value);
    });
    setComposerDraft(S1, { value: "a" });
    setComposerDraft(S1, { value: "ab" });
    unsubscribe();
    setComposerDraft(S1, { value: "abc" });
    assert.deepEqual(seen, ["a", "ab"]);
  });

  test("a write to ANY session notifies subscribers (the composer re-checks its key)", () => {
    // The keyed `useSyncExternalStore` getter re-reads on notification; a
    // write that no listener ever hears about could leave a stale box on
    // screen after a switch.
    let notified = 0;
    const unsubscribe = subscribeComposerDraft(() => {
      notified += 1;
    });
    setComposerDraft(S1, { value: "a" });
    setComposerDraft(S2, { value: "b" });
    unsubscribe();
    assert.equal(notified, 2);
  });

  test("patches merge — an attachments write must not drop `value`", () => {
    setComposerDraft(S1, { value: "text" });
    setComposerDraft(S1, { attachments: ["@one"] });
    assert.equal(getComposerDraft(S1).value, "text");
    assert.deepEqual(getComposerDraft(S1).attachments, ["@one"]);
  });
});

describe("unconfirmedPatchOnTurnEnd — the grey banner dies with its turn (P4)", () => {
  const unconfirmed: Pick<ComposerDraft, "errorKind"> = { errorKind: "unconfirmed" };

  test("running falling (true → false) clears the unconfirmed banner", () => {
    // The smoke-report scenario: `sleep 35` timed out at the 30s ack
    // deadline, the probe said "accepted", the turn finished — and the
    // grey banner stayed on screen. The fall is the retire signal.
    assert.deepEqual(
      unconfirmedPatchOnTurnEnd(true, false, unconfirmed.errorKind),
      { error: null, errorKind: null, unconfirmed: null },
    );
  });

  test("a turn still running keeps the banner", () => {
    assert.equal(unconfirmedPatchOnTurnEnd(true, true, "unconfirmed"), null);
  });

  test("no observed turn (false → false, e.g. banner set after a fast turn) keeps it", () => {
    // The fast-turn echo path never shows a running fall inside the same
    // mount; the pre-existing dismiss paths (next send, session switch)
    // stay responsible for that case. #126's display semantics untouched.
    assert.equal(unconfirmedPatchOnTurnEnd(false, false, "unconfirmed"), null);
  });

  test("a turn starting (false → true) never clears anything", () => {
    assert.equal(unconfirmedPatchOnTurnEnd(false, true, "unconfirmed"), null);
  });

  test("a real rejected refusal is NOT cleared by the turn ending", () => {
    // "消息发送失败" is a different fact — it stays until the user acts on
    // it or the next send in that session starts.
    assert.equal(unconfirmedPatchOnTurnEnd(true, false, "rejected"), null);
  });

  test("no banner at all → no patch", () => {
    assert.equal(unconfirmedPatchOnTurnEnd(true, false, null), null);
  });
});
