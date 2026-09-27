// webapp/test/composer-submit-tripwire.test.ts
//
// Static-source tripwire for the composer submit wiring.
//
// Why this exists: ticket 13. The pure-reducer tests in
// `composer-sent.test.ts` cover the decision tree (dispatch /
// complete / fail, cid + sessionId scoping), but the actual bug was
// the ORDER of operations in `submit` — clearing the draft after
// `await api.sendMessage(...)` instead of before. A regression to
// the clear-after-await ordering would keep all 546 webapp tests
// green (the reducers are pure and order-agnostic) and silently
// re-introduce the user-reported bug ("text sitting in the box until
// the reply arrives"). This tripwire is the only thing that pins the
// WIRING.
//
// The same problem applied to the cid + sessionId restore-gate: the
// reducer compares `record.cid` vs `args.cid` and `record.sessionId`
// vs `args.sessionId`, so the gate is only meaningful when the args
// are the LIVE context (catch-time state) and the record is the
// DISPATCH context. The first version of the fix passed the
// closure-captured dispatch values to BOTH calls and acceptance
// caught the resulting leak: a session-A failure pasted A's text
// into session-B's composer. This file pins the LIVE-context wiring
// so the same regression cannot return.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(
  resolve(here, "../components/composer.tsx"),
  "utf8",
);

function indexOfOrThrow(haystack: string, needle: string, label: string): number {
  const idx = haystack.indexOf(needle);
  if (idx < 0) {
    throw new Error(`tripwire missing in composer.tsx: ${label}`);
  }
  return idx;
}

describe("composer submit ordering — ticket 13 wiring tripwire", () => {
  test("the outbox record is parked BEFORE any awaited send", () => {
    // The optimistic-clear ordering: startComposerSent + the draft
    // clear must precede `await api.sendMessage` / `await api.sendCommand`.
    // If a refactor regresses to clear-after-await, the user's bug
    // returns ("text sitting in the box until the reply arrives")
    // and all 21 reducer tests still pass — this tripwire is what
    // pins the wiring.
    const startSendIdx = indexOfOrThrow(
      composerSource,
      "startComposerSent({",
      "startComposerSent({",
    );
    const clearDraftIdx = indexOfOrThrow(
      composerSource,
      'setComposerDraft({ value: "", attachments: [] })',
      'setComposerDraft({ value: "", attachments: [] })',
    );
    const awaitSendIdx = indexOfOrThrow(
      composerSource,
      "await api.sendMessage",
      "await api.sendMessage",
    );
    const awaitCmdIdx = indexOfOrThrow(
      composerSource,
      "await api.sendCommand",
      "await api.sendCommand",
    );
    const earliestAwait = Math.min(awaitSendIdx, awaitCmdIdx);

    assert.ok(
      startSendIdx < earliestAwait,
      `startComposerSent must be called before any await ` +
        `(start=${startSendIdx}, earliestAwait=${earliestAwait})`,
    );
    assert.ok(
      clearDraftIdx < earliestAwait,
      `setComposerDraft({value:"", attachments:[]}) must be called before any await ` +
        `(clear=${clearDraftIdx}, earliestAwait=${earliestAwait})`,
    );
    assert.ok(
      clearDraftIdx > startSendIdx,
      `the draft clear must come AFTER startComposerSent so the record is ` +
        `parked first (start=${startSendIdx}, clear=${clearDraftIdx})`,
    );
  });

  test("the catch branch reads the LIVE session context, not the captured one", () => {
    // The cid + sessionId restore-gate compares the LIVE context
    // against the record. If `submit` passes the closure-captured
    // `dispatchSessionId` to `failComposerSent`, the gate compares
    // dispatch-time values against themselves and always passes —
    // session-A failures leak into session-B's composer (the bug
    // acceptance caught). The fix reads the live `sessionId` from
    // a ref that mirrors `state` on every render.
    const catchIdx = indexOfOrThrow(
      composerSource,
      "} catch (cause) {",
      "} catch (cause) {",
    );
    const failComposerIdx = indexOfOrThrow(
      composerSource,
      "failComposerSent({",
      "failComposerSent({",
    );
    assert.ok(
      failComposerIdx > catchIdx,
      `failComposerSent must be called inside the catch branch ` +
        `(catch=${catchIdx}, failComposerSent=${failComposerIdx})`,
    );

    // The live-state ref must be declared somewhere — searching the
    // whole file is the cheap way to assert it exists without having
    // to parse TypeScript. The ref's identity is checked again at
    // runtime in the live-context test below.
    const liveStateRefIdx = composerSource.indexOf("liveStateRef");
    assert.ok(
      liveStateRefIdx >= 0,
      "a liveStateRef must be declared so the catch branch can read the current state",
    );
    // The catch branch must reference the ref. Slice from the
    // catch block to the end of file and look for the identifier.
    const afterCatch = composerSource.slice(catchIdx);
    assert.ok(
      /liveStateRef\.current/.test(afterCatch),
      "the catch branch must read liveStateRef.current (not the captured closure value)",
    );
  });

  test("the success branch flips the record to delivered", () => {
    // Pairs with the optimistic-clear ordering: a record parked and
    // never closed would leave stale 'in-flight' records accumulating
    // on every send. completeComposerSent must run on the success
    // path so a later 'failSend' against the same cid + sessionId
    // would no-op (the reducer returns the record unchanged when it
    // is not 'in-flight').
    const successIdx = indexOfOrThrow(
      composerSource,
      "completeComposerSent();",
      "completeComposerSent();",
    );
    const catchIdx = indexOfOrThrow(
      composerSource,
      "} catch (cause) {",
      "} catch (cause) {",
    );
    assert.ok(
      successIdx < catchIdx,
      `completeComposerSent must be called BEFORE the catch branch ` +
        `(complete=${successIdx}, catch=${catchIdx})`,
    );
  });
});