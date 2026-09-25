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

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getComposerDraft,
  resetComposerDraftForTests,
  setComposerDraft,
  subscribeComposerDraft,
} from "../lib/composer-draft";

beforeEach(() => {
  resetComposerDraftForTests();
});

describe("composer draft store — survives the composer's remount", () => {
  test("typed text written before the 'swap' is read by a fresh reader after it", () => {
    // The composer instance that existed before the remount wrote the text.
    setComposerDraft({ value: "继续这个任务" });
    // A fresh mount reads the module-scope store — the same object any
    // later instance sees, regardless of tree position.
    const afterRemount = getComposerDraft();
    assert.equal(afterRemount.value, "继续这个任务");
  });

  test("send-error banner survives the same remount", () => {
    // A 409 session-busy failure wrote the banner right before the push
    // that remounts the composer.
    setComposerDraft({ error: "this conversation is already running in another window" });
    assert.equal(getComposerDraft().error, "this conversation is already running in another window");
  });

  test("attachment chips survive the remount too", () => {
    setComposerDraft({ attachments: ["@uploads/a.txt"] });
    assert.deepEqual(getComposerDraft().attachments, ["@uploads/a.txt"]);
  });

  test("nothing resets the draft implicitly — only explicit writes do", () => {
    setComposerDraft({
      value: "draft",
      error: "boom",
      attachments: ["@uploads/a.txt"],
    });
    // Simulate any number of unrelated store readers/re-renders: reading
    // the store never mutates it, and there is no reset hook on the
    // production surface.
    for (let i = 0; i < 3; i++) {
      assert.equal(getComposerDraft().value, "draft");
      assert.equal(getComposerDraft().error, "boom");
    }
    // The only clearing write is the composer's own success path.
    setComposerDraft({ value: "", attachments: [] });
    assert.equal(getComposerDraft().value, "");
    assert.deepEqual(getComposerDraft().attachments, []);
    // The error banner persists until the next submit start clears it —
    // matches the pre-existing `setError(null)`-at-submit semantics.
    assert.equal(getComposerDraft().error, "boom");
  });
});

describe("composer draft store — subscription", () => {
  test("listeners are notified on every write", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeComposerDraft(() => {
      seen.push(getComposerDraft().value);
    });
    setComposerDraft({ value: "a" });
    setComposerDraft({ value: "ab" });
    unsubscribe();
    setComposerDraft({ value: "abc" });
    assert.deepEqual(seen, ["a", "ab"]);
  });

  test("updater form patches against the CURRENT draft", () => {
    setComposerDraft({ attachments: ["@one"] });
    setComposerDraft((current) => ({
      attachments: [...current.attachments, "@two"],
    }));
    assert.deepEqual(getComposerDraft().attachments, ["@one", "@two"]);
    // Patches merge — an attachments write must not drop `value`.
    setComposerDraft({ value: "text" });
    setComposerDraft((current) => ({ attachments: [...current.attachments, "@three"] }));
    assert.equal(getComposerDraft().value, "text");
    assert.deepEqual(getComposerDraft().attachments, ["@one", "@two", "@three"]);
  });
});
