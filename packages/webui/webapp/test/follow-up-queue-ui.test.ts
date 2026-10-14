// webapp/test/follow-up-queue-ui.test.ts
//
// Contract pins for PB-13 — the queue panel that makes a queued
// follow-up visible (`components/follow-up-queue-panel.tsx`).
//
// The webapp suite has no client-render harness: the only renderer is
// `renderToStaticMarkup`, and every panel path here is driven by a
// `useEffect` fetch and a poll interval, neither of which a static
// markup pass runs. A markup assertion would therefore pass in both
// the reachable and the unreachable state and prove nothing — the same
// situation `context-meter-toggle.test.ts` documents for the settings
// switches. So the render-critical wiring is pinned two ways:
//
//   1. the pure logic in `lib/follow-up-queue.ts`, driven for real —
//      the untrusted-boundary reader, the summary, the status mapping
//      and the reorder, all of which are where a wrong answer becomes
//      a wrong claim on screen;
//   2. the panel's own source, for the four decisions a markup pass
//      cannot reach: that the honest-boundary sentence is rendered for
//      `reachable:false` and NOT for an empty list, that the panel
//      renders nothing at all when no turn is running, that the two
//      actions go to the two engine endpoints, and that the position
//      shown is the INDEX rather than a number the client invented.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  QUEUE_REASON_TURN_NOT_HERE,
  clearQueuedFollowUps,
  describeQueueStatus,
  moveQueueItemIds,
  normalizeQueueItem,
  normalizeQueueSnapshot,
  pendingLocalRecords,
  readQueuedFollowUps,
  recordQueuedFollowUp,
  summarizeQueueContent,
  type QueueSnapshot,
} from "../lib/follow-up-queue";

const here = dirname(fileURLToPath(import.meta.url));
const repoFile = (...parts: string[]) => resolve(here, "..", ...parts);
const panelSource = readFileSync(repoFile("components/follow-up-queue-panel.tsx"), "utf8");
const composerSource = readFileSync(repoFile("components/composer.tsx"), "utf8");
const enSource = readFileSync(repoFile("lib/i18n.ts"), "utf8");

const reachable = (items: unknown[], extra: Partial<QueueSnapshot> = {}): QueueSnapshot => ({
  reachable: true,
  reason: null,
  items: items.map((item) => normalizeQueueItem(item)!),
  paused: false,
  pendingCount: items.length,
  ...extra,
});

describe("normalizeQueueSnapshot — the untrusted boundary", () => {
  test("reads the engine's answer field by field", () => {
    const snapshot = normalizeQueueSnapshot({
      ok: true,
      reachable: true,
      paused: true,
      pendingCount: 4,
      items: [
        { itemId: "qi_1", status: "queued", content: "hello", createdAt: 7, attachmentCount: 2 },
        { itemId: "qi_2", status: "queued", content: "world" },
      ],
    });
    assert.equal(snapshot.reachable, true);
    assert.equal(snapshot.paused, true);
    assert.equal(snapshot.pendingCount, 4);
    assert.deepEqual(
      snapshot.items.map((i) => i.itemId),
      ["qi_1", "qi_2"],
    );
    assert.equal(snapshot.items[0]?.content, "hello");
    assert.equal(snapshot.items[0]?.attachmentCount, 2);
  });

  test("an item with no id is dropped: it could not be cancelled or moved", () => {
    const snapshot = normalizeQueueSnapshot({
      reachable: true,
      items: [{ itemId: "keep" }, { status: "queued" }, null, "nope", { itemId: "" }],
    });
    assert.deepEqual(
      snapshot.items.map((i) => i.itemId),
      ["keep"],
    );
  });

  test("reachable:false is NOT an empty queue", () => {
    // The single most important distinction on this screen: an
    // unreachable answer and an empty queue are different facts, and
    // the panel words them differently.
    const unreachable = normalizeQueueSnapshot({ reachable: false, reason: "turn_not_here" });
    assert.equal(unreachable.reachable, false);
    assert.equal(unreachable.reason, "turn_not_here");
    assert.deepEqual(unreachable.items, []);
    const empty = normalizeQueueSnapshot({ reachable: true, items: [] });
    assert.equal(empty.reachable, true);
    assert.equal(empty.reason, null);
    assert.notEqual(unreachable.reachable, empty.reachable);
  });

  test("a malformed answer degrades to unreachable, never to empty", () => {
    // Rendering a garbage answer as "your queue is empty" is a claim
    // about the engine's queue that nobody made.
    for (const answer of [undefined, null, "nope", 42, [], { ok: true }]) {
      const snapshot = normalizeQueueSnapshot(answer);
      assert.equal(snapshot.reachable, false, `for ${JSON.stringify(answer)}`);
      assert.equal(snapshot.reason, QUEUE_REASON_TURN_NOT_HERE);
    }
  });

  test("pendingCount falls back to the item count rather than to zero", () => {
    const snapshot = normalizeQueueSnapshot({ reachable: true, items: [{ itemId: "a" }] });
    assert.equal(snapshot.pendingCount, 1);
  });

  test("an explicit pendingCount of zero stays zero", () => {
    // The engine can count fewer pending items than the list carries;
    // overwriting its 0 with a count of what is on screen would be the
    // client inventing a number.
    const snapshot = normalizeQueueSnapshot({
      reachable: true,
      pendingCount: 0,
      items: [{ itemId: "a" }],
    });
    assert.equal(snapshot.pendingCount, 0);
  });

  test("a missing status reads as queued, the only status the panel acts on", () => {
    assert.equal(normalizeQueueItem({ itemId: "a" })?.status, "queued");
  });
});

describe("summarizeQueueContent", () => {
  test("collapses whitespace before it measures", () => {
    // A message pasted from a terminal is mostly newlines; measuring
    // them first would spend the whole budget on layout.
    assert.equal(summarizeQueueContent("  a\n\n  b\tc  "), "a b c");
  });

  test("a short message is returned unchanged apart from its spacing", () => {
    assert.equal(summarizeQueueContent("hello there"), "hello there");
  });

  test("a long message is truncated with a single ellipsis", () => {
    const summary = summarizeQueueContent("x".repeat(200), 10);
    assert.equal(summary, `${"x".repeat(10)}…`);
    assert.equal(summary.length, 11);
  });

  test("truncation does not leave a trailing space before the ellipsis", () => {
    assert.equal(summarizeQueueContent("abcde fghij", 6), "abcde…");
  });

  test("a non-positive budget is empty, not the whole string", () => {
    assert.equal(summarizeQueueContent("hello", 0), "");
  });

  test("the truncation boundary is exact at max and max+1", () => {
    // Off-by-one here is invisible in review and visible to every user
    // whose message is exactly at the boundary.
    assert.equal(summarizeQueueContent("abcde", 5), "abcde");
    assert.equal(summarizeQueueContent("abcdef", 5), "abcde…");
    assert.equal(summarizeQueueContent("abcde", 6), "abcde");
  });
});

describe("describeQueueStatus", () => {
  test("maps the engine's vocabulary to a sentence key", () => {
    assert.equal(describeQueueStatus("queued"), "queue.status.queued");
    assert.equal(describeQueueStatus("paused"), "queue.status.paused");
    assert.equal(describeQueueStatus("cancelled"), "queue.status.cancelled");
    assert.equal(describeQueueStatus("failed"), "queue.status.failed");
  });

  test("an unknown status is its own case, not a leak of the raw token", () => {
    // The engine's status string is a protocol token, not UI copy.
    assert.equal(describeQueueStatus("something_new_upstream"), "queue.status.unknown");
  });
});

describe("moveQueueItemIds — the reorder the panel sends", () => {
  const ids = ["a", "b", "c"];

  test("moves toward the front and toward the back", () => {
    assert.deepEqual(moveQueueItemIds(ids, "b", -1), ["b", "a", "c"]);
    assert.deepEqual(moveQueueItemIds(ids, "b", 1), ["a", "c", "b"]);
  });

  test("refuses a move that is out of range, so no no-op is ever sent", () => {
    assert.equal(moveQueueItemIds(ids, "a", -1), null);
    assert.equal(moveQueueItemIds(ids, "c", 1), null);
  });

  test("refuses an item that is not in the list", () => {
    assert.equal(moveQueueItemIds(ids, "zzz", -1), null);
  });

  test("does not mutate its input", () => {
    const before = [...ids];
    moveQueueItemIds(ids, "a", 1);
    assert.deepEqual(ids, before);
  });
});

describe("the local record store is a gap filler, not a queue", () => {
  const SESSION = "sess_a";
  const OTHER = "sess_b";

  test("a record is kept per session and never leaks across them", () => {
    clearQueuedFollowUps(SESSION);
    clearQueuedFollowUps(OTHER);
    recordQueuedFollowUp(SESSION, { itemId: "qi_1", position: 0, content: "mine" });
    assert.deepEqual(
      readQueuedFollowUps(SESSION).map((r) => r.itemId),
      ["qi_1"],
    );
    assert.deepEqual(readQueuedFollowUps(OTHER), []);
  });

  test("a record with no engine item id is not remembered", () => {
    clearQueuedFollowUps("sess_c");
    // The server answers `itemId: null` when the engine reported none.
    // A record with a null id could not be cancelled or reordered even
    // if the panel invented one.
    recordQueuedFollowUp("sess_c", { itemId: null, position: 0, content: "x" });
    recordQueuedFollowUp("sess_c", { itemId: "", position: 0, content: "x" });
    assert.deepEqual(readQueuedFollowUps("sess_c"), []);
  });

  test("re-queueing the same item replaces the record rather than growing it", () => {
    clearQueuedFollowUps("sess_d");
    recordQueuedFollowUp("sess_d", { itemId: "qi_1", position: 0, content: "first" });
    recordQueuedFollowUp("sess_d", { itemId: "qi_1", position: 3, content: "first" });
    const records = readQueuedFollowUps("sess_d");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.position, 3);
  });

  test("a snapshot that already carries the id SUPPRESSES the local record", () => {
    clearQueuedFollowUps("sess_e");
    recordQueuedFollowUp("sess_e", { itemId: "qi_1", position: 0, content: "hello" });
    const snapshot = reachable([{ itemId: "qi_1", content: "hello" }]);
    assert.deepEqual(pendingLocalRecords("sess_e", snapshot), []);
  });

  test("a snapshot that does not carry the id leaves it visible, in send order", () => {
    clearQueuedFollowUps("sess_f");
    recordQueuedFollowUp("sess_f", { itemId: "qi_1", position: 0, content: "one" });
    recordQueuedFollowUp("sess_f", { itemId: "qi_2", position: 1, content: "two" });
    // An item the engine has never mentioned has no position in the
    // engine's list, so it is shown on its own, clearly marked.
    assert.deepEqual(
      pendingLocalRecords("sess_f", reachable([])).map((r) => r.itemId),
      ["qi_1", "qi_2"],
    );
  });

  test("an unreachable snapshot shows the local records it is the only record of", () => {
    clearQueuedFollowUps("sess_g");
    recordQueuedFollowUp("sess_g", { itemId: "qi_1", position: null, content: "one" });
    const unreachable = normalizeQueueSnapshot({ reachable: false, reason: "turn_not_here" });
    assert.deepEqual(
      pendingLocalRecords("sess_g", unreachable).map((r) => r.itemId),
      ["qi_1"],
    );
  });

  test("clearQueuedFollowUps is total and safe on an unknown session", () => {
    clearQueuedFollowUps("never_seen");
    clearQueuedFollowUps("sess_h");
    recordQueuedFollowUp("sess_h", { itemId: "qi_1", content: "x" });
    clearQueuedFollowUps("sess_h");
    assert.deepEqual(readQueuedFollowUps("sess_h"), []);
  });
});

describe("the panel's render-critical wiring", () => {
  test("it renders nothing at all unless a turn is running", () => {
    // A permanently visible empty panel in every conversation is noise;
    // the queue is the queue OF a turn.
    assert.match(panelSource, /if \(!running \|\| !sessionId\) return null;/);
  });

  test("the honest-boundary sentence is gated on reachability, not on emptiness", () => {
    // The order matters: a gate written as "no items" would print
    // "the engine is in another process" for a genuinely empty queue.
    assert.match(panelSource, /snapshot && !snapshot\.reachable[\s\S]{0,900}queue\.unreachable/);
    assert.match(panelSource, /snapshot\?\.reachable && snapshot\.items\.length === 0[\s\S]{0,400}queue\.empty/);
  });

  test("the two actions go to the two engine endpoints, and nowhere else", () => {
    assert.match(panelSource, /api\.reorderQueue\(/);
    assert.match(panelSource, /api\.cancelQueueItem\(/);
    // The order sent is the computed one, verbatim. A panel that sent
    // a re-sorted or reversed copy of it would move the wrong message.
    assert.match(panelSource, /api\.reorderQueue\(next\);/);
    assert.match(panelSource, /api\.cancelQueueItem\(itemId\);/);
    // No client-side stand-in for an action the engine does not have.
    assert.equal(/\.sort\s*\(/.test(panelSource), false);
    assert.equal(/\.reverse\(\)/.test(panelSource), false);
  });

  test("the composer records the text it queued, not a placeholder", () => {
    // A record with the right id and no text would render a blank row
    // that the user cannot identify to cancel.
    assert.match(
      composerSource,
      /recordQueuedFollowUp\(dispatchSessionId, \{[\s\S]{0,200}itemId: queued\.itemId[\s\S]{0,200}position: queued\.position[\s\S]{0,200}content,/,
    );
  });

  test("the position shown is the engine's index, not a number the client keeps", () => {
    assert.match(panelSource, /position=\{index\}/);
    assert.match(panelSource, /queue\.position"\)\.replace\("\{n\}", String\(position \+ 1\)\)/);
  });

  test("the poll only runs on an expanded panel, and it clears its timer", () => {
    // A poll that ran while collapsed would cost a request every four
    // seconds for the whole session, to render a chip that never
    // changes.
    assert.match(panelSource, /if \(!expanded \|\| !running \|\| !sessionId\) return;/);
    assert.match(panelSource, /return \(\) => clearInterval\(timer\);/);
  });

  test("a landed snapshot clears the local records for that session", () => {
    // The server wins: a record it does not mention is either already
    // run or never existed, and keeping it would resurrect a row the
    // engine has answered about.
    assert.match(panelSource, /clearQueuedFollowUps\(target\);/);
  });

  test("the composer records the ENGINE's answer, and only for a queue", () => {
    // A steer has no queue item and nothing to show. The record is
    // keyed by the WEBUI session the dispatch was for.
    assert.match(
      composerSource,
      /if \(action === "queue" && dispatchSessionId\) \{[\s\S]{0,300}recordQueuedFollowUp\(dispatchSessionId/,
    );
    assert.match(composerSource, /setQueueRefreshToken\(\(token\) => token \+ 1\);/);
  });

  test("the panel is mounted inside the composer's measure cap", () => {
    assert.match(composerSource, /<FollowUpQueuePanel[\s\S]{0,300}refreshToken=\{queueRefreshToken\}/);
  });
});

describe("the bilingual copy", () => {
  test("every key the panel uses exists in BOTH dictionaries", () => {
    const used = [...panelSource.matchAll(/t\("(queue\.[a-zA-Z.]+)"\)/g)].map((m) => m[1]);
    assert.ok(used.length >= 10, `expected the panel to use at least 10 queue keys, saw ${used.length}`);
    for (const key of used) {
      const occurrences = enSource.split(`"${key}":`).length - 1;
      // One English and one Chinese entry each.
      assert.equal(occurrences, 2, `key ${key} appears ${occurrences} time(s) in i18n.ts`);
    }
  });

  test("the five status labels are distinct within EACH dictionary", () => {
    // `describeQueueStatus` maps the engine's tokens to keys; if two
    // keys carried the same sentence the mapping would be pointless and
    // the user would read "Queued" for a cancelled message. Pinned per
    // dictionary, because the collision can be introduced in either one.
    const keys = [
      "queue.status.queued",
      "queue.status.paused",
      "queue.status.cancelled",
      "queue.status.failed",
      "queue.status.unknown",
    ];
    const valueOf = (key: string, from: number): string => {
      const index = enSource.indexOf(`"${key}":`, from);
      assert.ok(index > 0, `${key} missing from i18n.ts`);
      // The VALUE only. Comparing the whole `"key": "value",` line
      // would compare the keys too, and two statuses sharing a sentence
      // would look distinct because their keys differ.
      const line = enSource.slice(index, enSource.indexOf("\n", index));
      return line.slice(line.indexOf(":") + 1).trim().replace(/,$/, "");
    };
    for (const dictionary of ["english", "chinese"] as const) {
      const entries = keys.map((key) => {
        const first = valueOf(key, 0);
        // The second entry of the same key is the other dictionary;
        // starting the search past the first one finds it.
        const second = valueOf(key, enSource.indexOf(`"${key}":`) + 1);
        return dictionary === "english" ? first : second;
      });
      assert.equal(
        new Set(entries).size,
        entries.length,
        `duplicate ${dictionary} status copy: ${keys.map((k, i) => `${k}=${entries[i]}`).join(" | ")}`,
      );
    }
  });

  test("the unreachable sentence is honest in both languages", () => {
    // Neither language may describe an unreachable queue as empty, and
    // the emptiness check is case-insensitive so a capitalised rewrite
    // cannot slip past it. The second assertion is the other half: the
    // sentence has to SAY the boundary, not merely avoid the word
    // "empty".
    //
    // Both entries are located, not just the first: checking the first
    // one twice would pass while the Chinese copy said anything at all.
    const lines = enSource.split("\n");
    const indices = lines
      .map((line, index) => (line.includes('"queue.unreachable":') ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(indices.length, 2, `expected one queue.unreachable per dictionary, saw ${indices.length}`);
    const blocks = indices.map((index) => lines.slice(index, index + 4).join(" "));
    const zhBlock = blocks.find((block) => /[一-鿿]/.test(block));
    assert.ok(zhBlock, "the Chinese queue.unreachable entry was not found");
    const enBlock = blocks.find((block) => block !== zhBlock);
    assert.ok(enBlock, "the English queue.unreachable entry was not found");
    for (const block of blocks) {
      assert.doesNotMatch(block, /your queue is empty|队列为空/i);
    }
    assert.match(enBlock, /another engine process|tracked by this tab|lost on reload/);
    assert.match(zhBlock, /另一个引擎进程|本页签跟踪|刷新即失/);
  });
});
