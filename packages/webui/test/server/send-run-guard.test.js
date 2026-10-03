// webui/test/server/send-run-guard.test.js
//
// One live turn per (tab, conversation), per engine session, and per
// MAX_CONCURRENT slot.
//
// Background: every prompt spawns its own engine subprocess, and before this
// guard nothing stopped a second prompt for the same client from starting while
// the first was still in flight. Measured against a running server with a stub
// engine: two concurrent `POST /api/send` on one cid produced two engine
// processes each holding its own engine session; ten produced ten — while
// `GET /api/health` advertised `maxConcurrent: 3` and nothing read it.
//
// The guard is keyed by CONVERSATION, not by tab. `cid` is the browser-tab
// identity (one `localStorage['webui_cid']`, stable across a session switch so
// the client keeps one state object, one SSE channel and one engine
// connection), so a cid-wide lock made a long turn in one conversation refuse
// sends in every other conversation of the same tab with 409 `cid-busy`. The
// duplicate-execution guard is per conversation, and that is what these tests
// pin: same conversation twice is still refused.
//
// The engine-session index exists because a second browser tab is a second cid:
// `restoreLatestSession` binds a fresh client to the most recent session's
// `mcodeSessionId` with `running.active` false, so both tabs look idle. Two
// engine processes then hold one engine session, and `persistCurrentChat` is a
// read-modify-write of the whole store, so the slower writer's chat view
// overwrites the faster one's.

import test from "node:test";
import assert from "node:assert/strict";

import {
  beginRun,
  endRun,
  activeRunCount,
  getRunForSession,
  getRunsForCid,
  moveRunSession,
  updateRunSid,
  createRunChat,
  appendRunChatLine,
  runChatLinesFor,
  drainRunChat,
  viewOwnsLiveRun,
  snapshotViewFields,
} from "../../server/lib/state-bus.js";

// Each case gets its own module instance so the registries start empty — the
// registry is module state, and these tests assert on it directly.
async function freshBus() {
  const bust = `${Date.now()}-${Math.random()}`;
  return import(`../../server/lib/state-bus.js?case=${bust}`);
}

test("run guard — one turn per conversation", async (t) => {
  const bus = await freshBus();

  await t.test("a first claim succeeds and is visible", () => {
    const claim = bus.beginRun("c1", "mvs_a", "web-1");
    assert.equal(claim.ok, true);
    assert.equal(bus.activeRunCount(), 1);
    const run = bus.getRunForSession("c1", "web-1");
    assert.equal(run.sid, "mvs_a");
    assert.ok(run.startedAt > 0);
  });

  await t.test("a second claim on the same conversation is refused", () => {
    const second = bus.beginRun("c1", "mvs_a", "web-1");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "cid-busy");
    assert.match(second.detail, /session/);
    // The refusal must not have created a second slot.
    assert.equal(bus.activeRunCount(), 1);
  });

  await t.test("endRun releases the slot and the conversation can claim again", () => {
    bus.endRun("c1", "web-1");
    assert.equal(bus.activeRunCount(), 0);
    assert.equal(bus.getRunForSession("c1", "web-1"), null);
    assert.equal(bus.beginRun("c1", "mvs_a", "web-1").ok, true);
    bus.endRun("c1", "web-1");
  });

  await t.test("endRun on an unclaimed conversation is a no-op, not a throw", () => {
    bus.endRun("never-claimed", "web-x");
    assert.equal(bus.activeRunCount(), 0);
  });
});

// The bug this ticket fixes: a 40s turn in one conversation made every other
// conversation of the same tab answer 409 until it finished.
test("run guard — two conversations of ONE tab run in parallel", async (t) => {
  const bus = await freshBus();

  await t.test("a different conversation of the same cid is not blocked", () => {
    assert.equal(bus.beginRun("tab", "mvs_a", "web-A").ok, true);
    const b = bus.beginRun("tab", "mvs_b", "web-B");
    assert.equal(b.ok, true, "a second conversation of one tab must be claimable");
    assert.equal(bus.activeRunCount(), 2, "both turns hold a slot — each is a subprocess");
    assert.equal(bus.getRunsForCid("tab").length, 2);
  });

  await t.test("but the SAME conversation is still refused while it runs", () => {
    const again = bus.beginRun("tab", "mvs_a", "web-A");
    assert.equal(again.ok, false);
    assert.equal(again.reason, "cid-busy");
    // A draft turn (no engine session yet) is refused the same way.
    assert.equal(bus.beginRun("tab", null, null).ok, true);
    const draftAgain = bus.beginRun("tab", null, null);
    assert.equal(draftAgain.ok, false);
    assert.equal(draftAgain.reason, "cid-busy");
    assert.equal(bus.activeRunCount(), 3);
  });

  await t.test("releasing one conversation leaves the siblings running", () => {
    bus.endRun("tab", "web-A");
    assert.equal(bus.activeRunCount(), 2);
    assert.equal(bus.getRunForSession("tab", "web-A"), null);
    assert.ok(bus.getRunForSession("tab", "web-B"));
    assert.ok(bus.getRunForSession("tab", null));
    // A is free again while B still runs.
    assert.equal(bus.beginRun("tab", "mvs_a", "web-A").ok, true);
  });
});

// The draft key: `handleSend` claims BEFORE the record id exists, then creates
// it. The claim has to follow, or the next send into the same conversation
// would find a free key and start a duplicate turn.
test("run guard — a draft claim follows its new record id", async (t) => {
  const bus = await freshBus();

  await t.test("moveRunSession re-points the claim onto the created record", () => {
    assert.equal(bus.beginRun("tab", null, null).ok, true);
    assert.equal(bus.moveRunSession("tab", null, "web-new"), true);
    // P16: the retired key still resolves to the same run. A conversation
    // whose id changed under a live turn is still that conversation — the
    // next send into it must find the running turn, not a free key. Before
    // the alias this read null, and a send arriving in that window was acked
    // and handed to an engine session that was already executing, with its
    // echo lost from the transcript and the persisted record.
    assert.ok(
      bus.getRunForSession("tab", null),
      "the key the run was claimed under must still resolve to it",
    );
    assert.equal(
      bus.getRunForSession("tab", null),
      bus.getRunForSession("tab", "web-new"),
      "both keys must name the one run",
    );
    // The duplicate send the un-moved claim would have let through.
    const dup = bus.beginRun("tab", null, "web-new");
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, "cid-busy");
    // …and the same answer when the send presents the RETIRED key.
    assert.equal(bus.beginRun("tab", null, null).ok, false);
    assert.equal(bus.activeRunCount(), 1);
  });

  await t.test("releasing under either key frees the turn exactly once", () => {
    // The route's `finally` still holds the key it CLAIMED under, which is
    // the retired one once the record has been promoted. An alias-blind
    // release would miss here and strand the claim: every later send in
    // that conversation would be refused until the process ends.
    bus.endRun("tab", null);
    assert.equal(bus.activeRunCount(), 0, "releasing under the retired key must free the run");
    assert.equal(bus.getRunForSession("tab", "web-new"), null);
    // The current key works too, and a released run leaves no alias behind.
    assert.equal(bus.beginRun("tab", null, "web-new").ok, true);
    bus.endRun("tab", "web-new");
    assert.equal(bus.activeRunCount(), 0);
    assert.equal(bus.beginRun("tab", null, null).ok, true, "the retired key is free again");
    bus.endRun("tab", null);
    assert.equal(bus.activeRunCount(), 0);
  });

  await t.test("a move that would collide is refused", () => {
    assert.equal(bus.beginRun("t2", "mvs_x", "A").ok, true);
    assert.equal(bus.beginRun("t2", "mvs_y", "B").ok, true);
    assert.equal(bus.moveRunSession("t2", "B", "A"), false);
    assert.ok(bus.getRunForSession("t2", "B"), "the refused move leaves the run in place");
  });
});

test("run guard — one turn per engine session across cids", async (t) => {
  const bus = await freshBus();

  await t.test("a second cid on the same engine session is refused", () => {
    assert.equal(bus.beginRun("tab1", "mvs_shared", "A").ok, true);
    const other = bus.beginRun("tab2", "mvs_shared", "A");
    assert.equal(other.ok, false);
    assert.equal(other.reason, "session-busy");
    // A different engine session is unaffected.
    assert.equal(bus.beginRun("tab2", "mvs_other", "A").ok, true);
    assert.equal(bus.activeRunCount(), 2);
  });

  await t.test("ending one tab frees the engine session for the other", () => {
    bus.endRun("tab1", "A");
    assert.equal(bus.beginRun("tab3", "mvs_shared", "A").ok, true);
  });

  await t.test("a conversation with no known engine session is not session-blocked", async () => {
    const bus2 = await freshBus();
    assert.equal(bus2.beginRun("a", "mvs_x", "A").ok, true);
    // `sid: null` — the first turn of a brand-new conversation.
    assert.equal(bus2.beginRun("b", null, "A").ok, true);
  });
});

test("run guard — MAX_CONCURRENT is a real ceiling", async (t) => {
  const { MAX_CONCURRENT } = await import("../../server/lib/config.js");
  const bus = await freshBus();

  await t.test("the advertised limit is the enforced limit", () => {
    // Every slot is one conversation of one tab: a tab running two
    // conversations spends two slots, because that is two subprocesses.
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      assert.equal(bus.beginRun("slot", `mvs_${i}`, `web-${i}`).ok, true, `slot ${i} should be claimable`);
    }
    assert.equal(bus.activeRunCount(), MAX_CONCURRENT);
    const over = bus.beginRun("one-too-many", null, "web-x");
    assert.equal(over.ok, false);
    assert.equal(over.reason, "at-capacity");
    assert.equal(over.running, MAX_CONCURRENT);
    assert.equal(over.limit, MAX_CONCURRENT);
  });

  await t.test("freeing a slot admits the next claim", () => {
    bus.endRun("slot", "web-0");
    assert.equal(bus.beginRun("next", null, "web-n").ok, true);
  });
});

test("run guard — the default cid fallback", async (t) => {
  const bus = await freshBus();
  // Requests without a cid fall back to "default" everywhere else in the
  // server; the guard must not create a second, unshared namespace for them.
  assert.equal(bus.beginRun("", "mvs_a", "A").ok, true);
  const second = bus.beginRun(undefined, "mvs_a", "A");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "cid-busy");
  bus.endRun("", "A");
  assert.equal(bus.activeRunCount(), 0);
});

// The first-turn hole: `handleSend` claims the run with
// `beginRun(cid, cs.mcodeSessionId, cs.sessionId)` while `cs.mcodeSessionId` is
// still null (the engine session id only comes into existence inside
// runMcodeAcp's session/new). Until that claim is backfilled, `runsBySid` never
// guards the brand-new session: a second window that had already learned the
// new sid (sidebar switch / restoreLatestSession after the draft was promoted)
// sent to it and got a 200, then lost its prompt to the engine's "Session
// already has an active Turn". runMcodeAcp now calls updateRunSid mid-turn.
test("run guard — updateRunSid backfills a first-turn claim (session-busy hole)", async (t) => {
  const bus = await freshBus();

  await t.test("backfilled claim blocks a second cid on the new session", () => {
    // Window A: brand-new session, first turn — claimed with sid: null.
    assert.equal(bus.beginRun("tabA", null, "web-A").ok, true);
    assert.equal(bus.getRunForSession("tabA", "web-A").sid, null);
    // The engine session comes into existence mid-turn...
    assert.equal(bus.updateRunSid("tabA", "mvs_first", "web-A"), true);
    assert.equal(bus.getRunForSession("tabA", "web-A").sid, "mvs_first");
    // ...and window B (different cid, already knows the sid) must now be
    // refused with session-busy instead of acking and failing later.
    const other = bus.beginRun("tabB", "mvs_first", "web-A");
    assert.equal(other.ok, false);
    assert.equal(other.reason, "session-busy");
    assert.equal(bus.activeRunCount(), 1, "the refusal must not create a slot");
    // endRun drops the backfilled claim (ownership: tabA's run owns it).
    bus.endRun("tabA", "web-A");
    assert.equal(bus.beginRun("tabB", "mvs_first", "web-A").ok, true);
    bus.endRun("tabB", "web-A");
    assert.equal(bus.activeRunCount(), 0);
  });

  await t.test("a late beginRun racing the backfill cannot double-register", () => {
    // tabC claimed the sid first (it knew the sid before tabD's turn was
    // backfilled); the backfill must NOT overwrite the other run's claim.
    assert.equal(bus.beginRun("tabC", "mvs_race", "A").ok, true);
    assert.equal(bus.beginRun("tabD", null, "A").ok, true);
    assert.equal(bus.updateRunSid("tabD", "mvs_race", "A"), false);
    // tabD's entry keeps its (null) sid; tabC's claim stands.
    assert.equal(bus.getRunForSession("tabD", "A").sid, null);
    // Releasing tabD must not drop tabC's protection.
    bus.endRun("tabD", "A");
    const late = bus.beginRun("tabE", "mvs_race", "A");
    assert.equal(late.ok, false);
    assert.equal(late.reason, "session-busy");
    bus.endRun("tabC", "A");
    assert.equal(bus.activeRunCount(), 0);
  });

  await t.test("a sibling conversation in the same tab may hold the same sid key", () => {
    // tabF has two conversations; only the one the turn ran on is backfilled,
    // and endRun of that one must not touch the sibling.
    assert.equal(bus.beginRun("tabF", null, "A").ok, true);
    assert.equal(bus.beginRun("tabF", null, "B").ok, true);
    assert.equal(bus.updateRunSid("tabF", "mvs_known", "A"), true);
    assert.equal(bus.getRunForSession("tabF", "A").sid, "mvs_known");
    assert.equal(bus.getRunForSession("tabF", "B").sid, null);
    bus.endRun("tabF", "A");
    assert.equal(bus.getRunForSession("tabF", "B").sid, null, "the sibling survives");
    bus.endRun("tabF", "B");
  });

  await t.test("idempotent when beginRun already carried the real sid", () => {
    assert.equal(bus.beginRun("tabF2", "mvs_known", "A").ok, true);
    assert.equal(bus.updateRunSid("tabF2", "mvs_known", "A"), true);
    assert.equal(bus.activeRunCount(), 1);
    bus.endRun("tabF2", "A");
  });

  await t.test("re-points the claim after a load-failure fallback to a fresh session", () => {
    // Turn claimed on mvs_stale, session/load failed, runMcodeAcp created
    // mvs_fresh: the claim must move so mvs_fresh is guarded and mvs_stale
    // is released.
    assert.equal(bus.beginRun("tabG", "mvs_stale", "A").ok, true);
    assert.equal(bus.updateRunSid("tabG", "mvs_fresh", "A"), true);
    assert.equal(bus.getRunForSession("tabG", "A").sid, "mvs_fresh");
    assert.equal(bus.beginRun("tabH", "mvs_fresh", "A").ok, false);
    assert.equal(bus.beginRun("tabH", "mvs_fresh", "A").reason, "session-busy");
    // mvs_stale was released along with the re-point.
    assert.equal(bus.beginRun("tabH", "mvs_stale", "A").ok, true);
    bus.endRun("tabG", "A");
    bus.endRun("tabH", "A");
    assert.equal(bus.activeRunCount(), 0);
  });

  await t.test("no live run — nothing is claimed out of thin air", () => {
    assert.equal(bus.updateRunSid("never-claimed", "mvs_ghost", "A"), false);
    assert.equal(bus.updateRunSid("tabZ", null, "A"), false);
    assert.equal(bus.activeRunCount(), 0);
    // The refused backfill must not have registered the sid either.
    assert.equal(bus.beginRun("tabY", "mvs_ghost", "A").ok, true);
    bus.endRun("tabY", "A");
  });
});

// The line buffer is keyed by (cid, ENGINE session). It was rebuilt as a whole
// per-cid map on every create, which was safe only while a tab could hold one
// turn: with two conversations streaming, the second create wiped the first
// one's live buffer and its lines were lost at finalize.
test("run mirror — a sibling turn's line buffer survives", async (t) => {
  const bus = await freshBus();

  await t.test("creating a buffer for one conversation keeps the other's", () => {
    assert.equal(bus.beginRun("tab", "mvs_a", "A").ok, true);
    assert.equal(bus.beginRun("tab", "mvs_b", "B").ok, true);
    bus.createRunChat("tab", "mvs_a", [], "A");
    bus.appendRunChatLine("tab", "mvs_a", "● A1");
    bus.createRunChat("tab", "mvs_b", [], "B");
    bus.appendRunChatLine("tab", "mvs_b", "● B1");
    assert.deepEqual(bus.runChatLinesFor("tab", "mvs_a"), ["● A1"]);
    assert.deepEqual(bus.runChatLinesFor("tab", "mvs_b"), ["● B1"]);
  });

  await t.test("a re-key (load-failure fallback) still prunes its own stale key", () => {
    // Same turn re-points onto a fresh engine session: the old, unwritten
    // key must not linger.
    bus.createRunChat("tab", "mvs_a2", [], "A");
    bus.appendRunChatLine("tab", "mvs_a2", "● A2");
    bus.createRunChat("tab", "mvs_a3", [], "A");
    assert.equal(bus.runChatLinesFor("tab", "mvs_a2"), null, "the stale key is pruned");
    assert.deepEqual(bus.runChatLinesFor("tab", "mvs_a3"), []);
    // ...and the sibling is still intact.
    assert.deepEqual(bus.runChatLinesFor("tab", "mvs_b"), ["● B1"]);
  });

  await t.test("draining one conversation does not disturb the other", () => {
    assert.deepEqual(bus.drainRunChat("tab", "mvs_b"), ["● B1"]);
    assert.deepEqual(bus.drainRunChat("tab", "mvs_b"), null);
    assert.deepEqual(bus.runChatLinesFor("tab", "mvs_a3"), []);
  });
});

// The view contract: with two turns in one tab, only the session the user is
// LOOKING at may claim "thinking", and a sibling's turn must neither show up
// in this view nor switch its indicator off.
test("run mirror — view routing is per conversation, not per tab", async (t) => {
  const bus = await freshBus();
  const mkCs = (sessionId, mcodeSessionId) => ({
    sessionId,
    mcodeSessionId,
    chat: [`› ${sessionId}`],
    running: { active: true, prompt: "prompt", pid: 1, startedAt: 1, model: "m", sessionId: mcodeSessionId, lastDeltaAt: 1, tps: 5 },
    context: { thinkingStatus: "Running", tps: 5 },
  });

  await t.test("each session's view owns exactly its own run", () => {
    assert.equal(bus.beginRun("tab", "mvs_a", "A").ok, true);
    assert.equal(bus.beginRun("tab", "mvs_b", "B").ok, true);
    bus.createRunChat("tab", "mvs_a", [], "A");
    bus.appendRunChatLine("tab", "mvs_a", "● from A");
    bus.createRunChat("tab", "mvs_b", [], "B");
    bus.appendRunChatLine("tab", "mvs_b", "● from B");

    const viewA = mkCs("A", "mvs_a");
    const viewB = mkCs("B", "mvs_b");
    assert.equal(bus.viewOwnsLiveRun("tab", viewA), true);
    assert.equal(bus.viewOwnsLiveRun("tab", viewB), true);
    // Only the viewed session's own buffered lines are attached.
    assert.deepEqual(bus.snapshotViewFields("tab", viewA).chat, ["› A", "● from A"]);
    assert.deepEqual(bus.snapshotViewFields("tab", viewB).chat, ["› B", "● from B"]);
  });

  await t.test("an idle session in a tab with a running one stays idle", () => {
    const viewIdle = mkCs("C", null);
    bus.beginRun("tab", null, "C");
    const fields = bus.snapshotViewFields("tab", viewIdle);
    assert.equal(fields.running.active, false, "a sibling turn must not claim this view");
    assert.deepEqual(fields.chat, ["› C"], "and must not spill its lines in");
  });

  await t.test("switched away and back: the owning view regains its indicator", () => {
    const backToB = mkCs("B", "mvs_b");
    backToB.running = { active: false, prompt: null, pid: null, startedAt: null, model: null, sessionId: null, lastDeltaAt: null, tps: 0 };
    const fields = bus.snapshotViewFields("tab", backToB);
    assert.equal(fields.running.active, true);
    assert.equal(fields.running.sessionId, "mvs_b");
  });
});
