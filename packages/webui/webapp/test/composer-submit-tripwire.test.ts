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
// into session-B's composer. v2 moved to a per-instance ref
// (`liveStateRef.current`); that worked for chat→chat switches but
// not for the 新建会话 → fresh empty B flow, because page.tsx swaps
// the composer between the inline and chat-tree positions when
// `hasConversation` flips. The current fix reads from the
// MODULE-scope store snapshot (lib/store.tsx#getActiveSessionId)
// so the live session id outlives any composer remount.
//
// The tripwire is intentionally tight: every assertion checks the
// call site (that an identifier appears AT THE CALL with the right
// meaning), not just that the identifier exists somewhere in the
// file. A plausible revert that passes `dispatchSessionId` to
// `failComposerSent` while still importing `getActiveSessionId`
// fails the live-context assertion; a refactor that moves the
// `await api.sendMessage` ahead of `setComposerDraft({ value: "",
// attachments: [] })` fails the ordering assertion. A tripwire
// that cannot fail on a plausible revert is decoration.

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

/**
 * Slice the source from a marker to the next `};` or end-of-file.
 * Returns just enough context for the call-site assertion below.
 */
function sliceAfter(haystack: string, marker: string, label: string, maxLen = 1200): string {
  const idx = indexOfOrThrow(haystack, marker, label);
  return haystack.slice(idx, idx + maxLen);
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
      'setComposerDraft(dispatchDraftKey, { value: "", attachments: [] })',
      'setComposerDraft(dispatchDraftKey, { value: "", attachments: [] })',
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

  test("the catch branch passes LIVE module-scope values to failComposerSent", () => {
    // The cid + sessionId restore-gate compares the LIVE context
    // against the record. If `submit` passes the closure-captured
    // `dispatchSessionId` to `failComposerSent`, the gate compares
    // dispatch-time values against themselves and always passes —
    // session-A failures leak into session-B's composer (the bug
    // both rounds of acceptance caught).
    //
    // The fix reads the live session id from the MODULE-scope
    // store snapshot (`getActiveSessionId()` from lib/store.tsx).
    // The cid side has always been module-scope (`clientId()` from
    // lib/cid.ts).
    //
    // The assertions below are on the CATCH BLOCK as a whole, not
    // the identifier presence. A plausible revert that keeps the
    // live-context identifier somewhere in the file but passes
    // closure constants to `failComposerSent` will trip this —
    // the catch branch must call `clientId()` AND
    // `getActiveSessionId()`, and the dispatch-time constants must
    // NOT appear at the call site.

    // Slice the catch block: from `} catch (cause) {` to the end of
    // file, then take just the call-site argument window. Use a
    // generous window so the surrounding `liveCid = clientId()`
    // assignments are still in the slice (a refactor that reads
    // `clientId()` inline at the call site would also pass; the
    // important property is that the call uses the module-scope
    // accessor, not a closure constant).
    const catchStartIdx = indexOfOrThrow(
      composerSource,
      "} catch (cause) {",
      "} catch (cause) {",
    );
    const callIdx = indexOfOrThrow(
      composerSource,
      "failComposerSent({",
      "failComposerSent({",
    );
    assert.ok(
      callIdx > catchStartIdx,
      "failComposerSent must be called inside the catch branch",
    );
    // Slice the catch block from `} catch (cause) {` through the
    // failComposerSent call (and a little beyond). This captures
    // both the live-value definitions and the call site.
    const catchSlice = composerSource.slice(catchStartIdx, callIdx + 600);

    // The live module-scope accessors must appear in the catch
    // block. Both `clientId()` (lib/cid.ts) and
    // `getActiveSessionId()` (lib/store.tsx) are module-scope —
    // they survive any composer remount and reflect the SSE-driven
    // state pushes. The cid side has always been module-scope; the
    // sessionId side moved from a per-instance ref to this accessor
    // because the per-instance ref froze at dispatch time when
    // page.tsx swapped the composer between the inline and chat-tree
    // positions on a fresh-session switch.
    assert.ok(
      /clientId\s*\(\s*\)/.test(catchSlice),
      "the catch block must call clientId() — cid is module-scope and a " +
        "closure constant cid breaks cross-tab isolation",
    );
    assert.ok(
      /getActiveSessionId\s*\(\s*\)/.test(catchSlice),
      "the catch block must call getActiveSessionId() — the live session id " +
        "must come from the module-scope store snapshot, not from a per-" +
        "instance ref or closure constant. Per-instance refs die with the " +
        "composer (page.tsx swaps the composer between two tree positions " +
        "when hasConversation flips), which is exactly what the 新建会话 → " +
        "fresh empty B scenario does.",
    );

    // The dispatch-time constants must NOT appear inside the
    // failComposerSent argument list. They MAY appear elsewhere in
    // the catch block (the cid might still be re-read for logging),
    // but they must not be the values fed to the gate.
    const callArgs = composerSource.slice(
      callIdx,
      composerSource.indexOf("});", callIdx) + 3,
    );
    assert.ok(
      !/\bdispatchSessionId\b/.test(callArgs),
      "failComposerSent must not be passed dispatchSessionId — that was " +
        "the v1 bug. The arg must be the LIVE value (getActiveSessionId()).",
    );
    assert.ok(
      !/\bdispatchCid\b/.test(callArgs),
      "failComposerSent must not be passed dispatchCid — cid is module-scope " +
        "via clientId() and must be read at catch time, not reused from " +
        "dispatch.",
    );
  });

  test("the live accessor is imported into the composer module", () => {
    // A plausible revert could remove the import and pass closure
    // constants — the call site check above would still catch it
    // (the call site would lack `getActiveSessionId()`), but
    // belt-and-braces: the import must be present at the top of
    // the module.
    assert.ok(
      /import\s+\{[^}]*\bgetActiveSessionId\b[^}]*\}\s+from\s+["']@\/lib\/store["']/.test(
        composerSource,
      ),
      "getActiveSessionId must be imported from @/lib/store at the top of " +
        "the composer module — the catch branch needs the module-scope " +
        "accessor.",
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
describe("the draft store is keyed by session (webui-parity 106, smoke P5)", () => {
  // The pre-106 store was ONE shared bucket: session A's draft, chips and
  // failure banner rode into session B's view on a switch (the s28 capture
  // in the smoke report). #141 papered over the banner half with a
  // sessionKey-keyed clear effect — which also destroyed the banner of the
  // session the user was RETURNING to. Since 106 the isolation is
  // structural: the composer reads and writes the store THROUGH the active
  // session key, and the catch branch writes the banner into the DISPATCH
  // session's box. These tripwires pin that wiring; the store-level
  // behaviour itself is unit-tested in composer-draft.test.ts.

  test("the composer's draft snapshot is read through the session key", () => {
    // A revert to the shared bucket re-appears as `getComposerDraft` being
    // called with NO key in the useSyncExternalStore call.
    assert.match(
      composerSource,
      /useSyncExternalStore\(\s*subscribeComposerDraft,\s*\(\) => getComposerDraft\(sessionKey\),\s*\(\) => getComposerDraft\(""\),?\s*\)/,
      "the draft snapshot must be read through the session key so a switch " +
        "swaps boxes synchronously — a key-less getter is the shared-bucket " +
        "regression this ticket fixes",
    );
  });

  test("the #141 clear effect is gone — isolation is structural now", () => {
    // The clear-on-switch effect destroyed a RETURNING session's own
    // unread banner. With per-session boxes it is wrong in every case.
    assert.ok(
      !/useEffect\(\(\) => \{\s*setComposerDraft\(\{?\s*error: null,\s*errorKind: null,\s*unconfirmed: null,?\s*\}?\);?\s*\}, \[sessionKey\]\);/.test(
        composerSource,
      ),
      "the sessionKey-keyed banner-clear effect must not come back — the " +
        "keyed store already isolates banners per session, and clearing on " +
        "switch loses the session the user returns to",
    );
  });

  test("every submit-path write carries a session key", () => {
    // A key-less setComposerDraft call site would write into whatever
    // box... nothing — it is a type error; the tripwire pins the two
    // load-bearing literals so a refactor that drops the key from them
    // fails here rather than silently changing boxes.
    assert.ok(
      /setComposerDraft\(dispatchDraftKey, \{\s*error: null,\s*errorKind: null,\s*unconfirmed: null,?\s*\}\)/.test(
        composerSource,
      ),
      "submit must clear the banner in the DISPATCH session's box",
    );
    assert.match(
      composerSource,
      /setComposerDraft\(dispatchDraftKey, \{ value: "", attachments: \[\] \}\)/,
      "the optimistic clear must write the dispatch session's box",
    );
  });

  test("the catch branch writes the banner into the dispatch session's box", () => {
    // The failure belongs to the session that attempted the send. Writing
    // it into the LIVE key would repaint the session the user switched TO
    // — the exact bleed the s28 capture shows.
    const catchStartIdx = indexOfOrThrow(
      composerSource,
      "} catch (cause) {",
      "} catch (cause) {",
    );
    const catchBody = composerSource.slice(catchStartIdx);
    assert.match(
      catchBody,
      /setComposerDraft\(dispatchDraftKey, \{\s*error: errorMessage,/,
      "the banner must be keyed by dispatchDraftKey inside the catch branch",
    );
    assert.ok(
      !/setComposerDraft\(sessionKey, \{[^}]*errorMessage/.test(catchBody),
      "the banner must NOT be written into the live session's box — a send " +
        "that failed in session A must never paint session B red",
    );
  });

  test("the submit path still clears the banner before dispatching", () => {
    // A same-session retry also has to clear the old rejection before the
    // new attempt is judged.
    assert.match(
      composerSource,
      /setSending\(true\);\s*setComposerDraft\(dispatchDraftKey, \{\s*error: null,\s*errorKind: null,\s*unconfirmed: null,?\s*\}\);/,
      "submit must clear the banner right after setSending(true), before the " +
        "optimistic park — a same-session retry starts clean",
    );
  });
});

describe("the unconfirmed banner retires when its turn ends (webui-parity 106, smoke P4)", () => {
  // After `sleep 35` finished, the grey "服务器一直没有确认" banner stayed
  // under the input until the next send or a reload. The decision
  // (running-flag fall + errorKind === "unconfirmed") is unit-tested in
  // composer-draft.test.ts; this pins the WIRING: the composer must feed
  // the turn-end transition into it and apply the patch it returns.

  test("the composer watches the running flag and applies the turn-end patch", () => {
    assert.match(
      composerSource,
      /const prevRunningRef = useRef\(running\);/,
      "the previous running value must be captured per render",
    );
    const effectIdx = indexOfOrThrow(
      composerSource,
      "unconfirmedPatchOnTurnEnd(",
      "unconfirmedPatchOnTurnEnd( call",
    );
    const wiring = composerSource.slice(effectIdx - 200, effectIdx + 400);
    assert.match(
      wiring,
      /prevRunningRef\.current,\s*running,\s*errorKind,/,
      "the decision must receive (previous running, running, errorKind)",
    );
    assert.match(
      wiring,
      /prevRunningRef\.current = running;/,
      "the reference must advance after the decision, or one stale value " +
        "would clear (or keep) the banner on unrelated re-renders",
    );
    assert.match(
      wiring,
      /if \(patch\) setComposerDraft\(sessionKey, patch\);/,
      "a non-null patch must be applied to the ACTIVE session's box",
    );
  });

  test("the turn-end decision is imported from the draft module", () => {
    assert.match(
      composerSource,
      /import\s+\{[^}]*\bunconfirmedPatchOnTurnEnd\b[^}]*\}\s+from\s+["']@\/lib\/composer-draft["']/,
      "the decision must be the product function, not an inline re-derivation",
    );
  });
});

describe("the model picker's local state resets on a session switch (webui-parity 106, smoke P5)", () => {
  // The chip VALUE reads the server snapshot, but the cascade's open flag,
  // previewed row and per-model draft mirror are component-local; without a
  // reset, session A's open menu / preview state visually persisted into
  // session B's view.

  test("ModelSelect receives the session key", () => {
    assert.match(
      composerSource,
      /<ModelSelect\s[^>]*sessionKey=\{sessionKey\}/,
      "the composer must pass the session key down to the picker",
    );
  });

  test("the picker resets its local states in an effect keyed on sessionKey", () => {
    // Three local states, and the fly-out's owner is one of them: an open
    // menu, a fly-out anchored to a row, and the per-model draft mirror
    // are all component-local, and without a reset session A's state
    // visually persists into session B.
    const resetIdx = indexOfOrThrow(
      composerSource,
      "setOpen(false);\n    setFlyoutFor(null);\n    setDrafts({});",
      "ModelSelect's local-state resets",
    );
    const deps = composerSource.slice(resetIdx, resetIdx + 200);
    assert.match(deps, /\}, \[sessionKey\]\);/, "the reset must be keyed on sessionKey");
  });
});
