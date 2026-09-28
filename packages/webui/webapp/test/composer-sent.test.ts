// webapp/test/composer-sent.test.ts
//
// Contract tests for `lib/composer-sent.ts` — the composer's outbox.
//
// Why this exists: ticket 13 (composer-send-echo). The bug was that the
// composer's success path cleared the draft AFTER the awaited request
// resolved, so the entire in-flight window left the text sitting in the
// box (the user's screenshot showed exactly that). The fix moves the
// clear BEFORE the await and parks the message in a module-scope
// outbox; on failure, the outbox is the only place the message lives
// and the catch branch reads it back into the composer. These tests
// pin the three transitions the composer relies on so a regression in
// the pure logic surfaces without a browser:
//
//   1. dispatch    — start a new send (status -> in-flight, outbox
//                    carries the text + attachments).
//   2. complete    — mark an in-flight record delivered. A late write
//                    after a failure must NOT silently flip the record
//                    back to delivered (that would hide the failure).
//   3. fail        — mark failed and (when cid + sessionId still
//                    match) hand back the restore payload. A cid or
//                    sessionId mismatch returns `null` and leaves the
//                    record untouched, so switching sessions while a
//                    send is in flight never pastes another session's
//                    text into the new session's composer.
//
// The module-scope store wrapper is also tested for its `subscribe`
// notification contract, which mirrors `composer-draft.ts`'s so the
// two stores share the same React-free shape.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  completeComposerSent,
  completeSend,
  dispatchSend,
  failComposerSent,
  failSend,
  getComposerSent,
  recordMatches,
  resetComposerSentForTests,
  startComposerSent,
  subscribeComposerSent,
} from "../lib/composer-sent";

const CID_A = "cid-aaaa";
const CID_B = "cid-bbbb";
const SESSION_1 = "session-1";
const SESSION_2 = "session-2";

beforeEach(() => {
  resetComposerSentForTests();
});

describe("dispatchSend — optimistic clear records the in-flight message", () => {
  test("creates an in-flight record with the dispatch context", () => {
    const record = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "继续这个任务",
      attachments: ["@uploads/a.txt"],
      timestamp: 1_700_000_000_000,
    });
    assert.equal(record.status, "in-flight");
    assert.equal(record.error, null);
    assert.equal(record.cid, CID_A);
    assert.equal(record.sessionId, SESSION_1);
    assert.equal(record.content, "继续这个任务");
    assert.deepEqual(record.attachments, ["@uploads/a.txt"]);
    assert.equal(record.timestamp, 1_700_000_000_000);
  });

  test("attachments array is copied, not aliased", () => {
    const attachments = ["@uploads/a.txt"];
    const record = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments,
      timestamp: 1,
    });
    // Mutating the caller's array must not leak into the record. This
    // is what the composer relies on: the draft store and the outbox
    // share the attachments array via reference, and a clear-then-
    // reassign in the draft store would otherwise also rewrite the
    // outbox.
    attachments.push("@uploads/b.txt");
    assert.deepEqual(record.attachments, ["@uploads/a.txt"]);
  });

  test("sessionId null is allowed — covers the pre-snapshot window", () => {
    const record = dispatchSend({
      cid: CID_A,
      sessionId: null,
      content: "first message before session id lands",
      attachments: [],
      timestamp: 1,
    });
    assert.equal(record.sessionId, null);
  });
});

describe("completeSend — success path", () => {
  test("in-flight -> delivered, error cleared", () => {
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: [],
      timestamp: 1,
    });
    const completed = completeSend(dispatched);
    assert.equal(completed.status, "delivered");
    assert.equal(completed.error, null);
    // content / attachments / cid / sessionId preserved through the
    // transition — the delivered marker is the only thing that
    // changes.
    assert.equal(completed.content, "msg");
    assert.equal(completed.cid, CID_A);
    assert.equal(completed.sessionId, SESSION_1);
  });

  test("already-delivered write is idempotent", () => {
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: [],
      timestamp: 1,
    });
    const first = completeSend(dispatched);
    const second = completeSend(first);
    assert.equal(second.status, "delivered");
    // Same identity (no spread) — a no-op reducer should not allocate.
    assert.equal(second, first);
  });

  test("late success after a failure does NOT mark the record delivered", () => {
    // The composer's success branch runs in the try, the failure
    // branch runs in the catch. If the server eventually acks AFTER
    // the catch already ran (very late retry, double-tap on Enter,
    // etc.) a completeSend against the failed record must not flip
    // it back to delivered — that would silently hide the failure
    // banner the user is looking at.
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: [],
      timestamp: 1,
    });
    const failed = failSend(dispatched, {
      cid: CID_A,
      sessionId: SESSION_1,
      error: "boom",
      timestamp: 2,
    })!.record;
    const lateSuccess = completeSend(failed);
    assert.equal(lateSuccess.status, "failed");
    assert.equal(lateSuccess.error, "boom");
  });
});

describe("failSend — failure path with cid + sessionId scoping", () => {
  test("matching cid + sessionId returns the restore payload and marks failed", () => {
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "继续这个任务",
      attachments: ["@uploads/a.txt"],
      timestamp: 1,
    });
    const result = failSend(dispatched, {
      cid: CID_A,
      sessionId: SESSION_1,
      error: "no response within 30000ms",
      timestamp: 2,
    });
    assert.ok(result, "failSend must return a result on a matching context");
    assert.equal(result!.record.status, "failed");
    assert.equal(result!.record.error, "no response within 30000ms");
    assert.equal(result!.record.timestamp, 2);
    // The payload the composer restores into the textarea + chip list.
    assert.deepEqual(result!.payload, {
      content: "继续这个任务",
      attachments: ["@uploads/a.txt"],
    });
  });

  test("payload attachments are copied, not aliased to the record", () => {
    // Same isolation guarantee as dispatchSend: a later draft-store
    // clear must not also wipe the payload the catch branch is about
    // to write back.
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: ["@a", "@b"],
      timestamp: 1,
    });
    const result = failSend(dispatched, {
      cid: CID_A,
      sessionId: SESSION_1,
      error: "x",
      timestamp: 2,
    })!;
    const payload = result.payload;
    // A new dispatch from the store wrapper would replace the record,
    // not mutate the payload's attachments array — the test below
    // pins this by re-dispatching and re-reading the payload array
    // identity would change anyway, so we instead check that the
    // payload array is not the SAME reference as the record's
    // attachments array.
    assert.notEqual(payload.attachments, dispatched.attachments);
  });

  test("cid mismatch -> null, record untouched", () => {
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: [],
      timestamp: 1,
    });
    const result = failSend(dispatched, {
      cid: CID_B, // wrong cid
      sessionId: SESSION_1,
      error: "x",
      timestamp: 2,
    });
    assert.equal(result, null);
    // Caller is expected to leave the record alone on a null return.
    assert.equal(dispatched.status, "in-flight");
  });

  test("sessionId mismatch -> null, record untouched (the session-switch case)", () => {
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg in session 1",
      attachments: [],
      timestamp: 1,
    });
    // User has now switched to session 2; the cid is the same (same
    // browser) but the session is different. Restoring here would
    // paste session-1's text into session-2's composer — the bug
    // the scoping exists to prevent.
    //
    // This is the test that would have caught acceptance's first-
    // pass regression: if the caller wired `failComposerSent` to
    // receive the DISPATCH-time sessionId (the same value already
    // on the record), this assertion would still hold because the
    // reducer is correct — the bug was in the CALLER, not the
    // reducer. The composer's tripwire test pins the wiring; this
    // test pins the reducer's behaviour when given the right input.
    const result = failSend(dispatched, {
      cid: CID_A,
      sessionId: SESSION_2,
      error: "x",
      timestamp: 2,
    });
    assert.equal(result, null);
    assert.equal(dispatched.status, "in-flight");
  });

  test("live-context semantics: args are the LIVE catch-time context", () => {
    // The contract the composer's catch branch relies on: the
    // second argument to failSend is the LIVE context — what the
    // user is currently looking at — and is checked against the
    // DISPATCH context stored in the record. A rotation between
    // dispatch and catch (session switch, cid rotation) is exactly
    // what the gate exists to catch. The composer's tripwire pins
    // the wiring (the caller reads the live context at catch
    // time); this test pins the reducer's contract.
    const dispatched = dispatchSend({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg in session 1",
      attachments: ["@uploads/a.txt"],
      timestamp: 1,
    });
    // Catch time: user has switched to session 2 (same cid).
    const liveResult = failSend(dispatched, {
      cid: CID_A,
      sessionId: SESSION_2,
      error: "x",
      timestamp: 2,
    });
    assert.equal(liveResult, null, "session rotation must abort the restore");
    // And when the active session matches the dispatch session,
    // the same record IS restored — the gate is symmetric.
    const sameSessionResult = failSend(dispatched, {
      cid: CID_A,
      sessionId: SESSION_1,
      error: "x",
      timestamp: 3,
    });
    assert.ok(sameSessionResult);
    assert.equal(sameSessionResult!.record.status, "failed");
    assert.deepEqual(sameSessionResult!.payload.attachments, ["@uploads/a.txt"]);
  });

  test("null record -> null (defensive: store wrapper already guards this)", () => {
    const result = failSend(null, {
      cid: CID_A,
      sessionId: SESSION_1,
      error: "x",
      timestamp: 1,
    });
    assert.equal(result, null);
  });
});

describe("recordMatches — pure cid + sessionId check", () => {
  const record = dispatchSend({
    cid: CID_A,
    sessionId: SESSION_1,
    content: "msg",
    attachments: [],
    timestamp: 1,
  });

  test("matching context -> true", () => {
    assert.equal(recordMatches(record, CID_A, SESSION_1), true);
  });
  test("cid mismatch -> false", () => {
    assert.equal(recordMatches(record, CID_B, SESSION_1), false);
  });
  test("sessionId mismatch -> false", () => {
    assert.equal(recordMatches(record, CID_A, SESSION_2), false);
  });
  test("null record -> false", () => {
    assert.equal(recordMatches(null, CID_A, SESSION_1), false);
  });
});

describe("store wrapper — module-scope subscribe/get, mirrors composer-draft.ts", () => {
  test("startComposerSent writes a record visible to getComposerSent", () => {
    startComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: ["@uploads/a.txt"],
    });
    const record = getComposerSent();
    assert.ok(record);
    assert.equal(record!.status, "in-flight");
    assert.equal(record!.content, "msg");
    assert.deepEqual(record!.attachments, ["@uploads/a.txt"]);
  });

  test("completeComposerSent flips an in-flight record to delivered", () => {
    startComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: [],
    });
    completeComposerSent();
    assert.equal(getComposerSent()!.status, "delivered");
  });

  test("completeComposerSent is a no-op when there is no record", () => {
    // Defensive: the catch branch of the composer should never call
    // completeComposerSent, but if a future refactor wires it
    // incorrectly the guard prevents an exception.
    completeComposerSent();
    assert.equal(getComposerSent(), null);
  });

  test("failComposerSent returns the restore payload on matching context", () => {
    startComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: ["@a"],
    });
    const payload = failComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      error: "boom",
    });
    assert.deepEqual(payload, { content: "msg", attachments: ["@a"] });
    assert.equal(getComposerSent()!.status, "failed");
    assert.equal(getComposerSent()!.error, "boom");
  });

  test("failComposerSent on session-switch returns null and leaves record untouched", () => {
    startComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "msg",
      attachments: [],
    });
    const payload = failComposerSent({
      cid: CID_A,
      sessionId: SESSION_2,
      error: "x",
    });
    assert.equal(payload, null);
    // The record is the original dispatch — switching sessions must
    // never leak the text, but the record is also not rewritten, so a
    // later dispatcher (the next send in session 1, if the user
    // navigates back) sees the unchanged record it overwrites.
    assert.equal(getComposerSent()!.status, "in-flight");
  });

  test("a second dispatch overwrites the previous record", () => {
    startComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "first",
      attachments: [],
    });
    startComposerSent({
      cid: CID_A,
      sessionId: SESSION_1,
      content: "second",
      attachments: [],
    });
    assert.equal(getComposerSent()!.content, "second");
    assert.equal(getComposerSent()!.status, "in-flight");
  });

  test("subscribers are notified on every write", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeComposerSent(() => {
      seen.push(getComposerSent()?.content ?? "(none)");
    });
    startComposerSent({ cid: CID_A, sessionId: SESSION_1, content: "a", attachments: [] });
    startComposerSent({ cid: CID_A, sessionId: SESSION_1, content: "b", attachments: [] });
    unsubscribe();
    startComposerSent({ cid: CID_A, sessionId: SESSION_1, content: "c", attachments: [] });
    assert.deepEqual(seen, ["a", "b"]);
  });

  test("completeComposerSent and failComposerSent also notify", () => {
    let calls = 0;
    const unsubscribe = subscribeComposerSent(() => {
      calls += 1;
    });
    startComposerSent({ cid: CID_A, sessionId: SESSION_1, content: "a", attachments: [] });
    assert.equal(calls, 1);
    completeComposerSent();
    assert.equal(calls, 2);
    startComposerSent({ cid: CID_A, sessionId: SESSION_1, content: "b", attachments: [] });
    assert.equal(calls, 3);
    failComposerSent({ cid: CID_A, sessionId: SESSION_1, error: "x" });
    assert.equal(calls, 4);
    unsubscribe();
  });
});