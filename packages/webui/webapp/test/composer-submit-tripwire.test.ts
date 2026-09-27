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