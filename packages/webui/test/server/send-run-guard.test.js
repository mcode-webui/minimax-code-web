// webui/test/server/send-run-guard.test.js
//
// One live turn per cid, per engine session, and per MAX_CONCURRENT slot.
//
// Background: every prompt spawns its own engine subprocess, and before this
// guard nothing stopped a second prompt for the same client from starting while
// the first was still in flight. Measured against a running server with a stub
// engine: two concurrent `POST /api/send` on one cid produced two engine
// processes each holding its own engine session; ten produced ten — while
// `GET /api/health` advertised `maxConcurrent: 3` and nothing read it.
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
  getRunForCid,
} from "../../server/lib/state-bus.js";

// Each case gets its own module instance so the registries start empty — the
// registry is module state, and these tests assert on it directly.
async function freshBus() {
  const bust = `${Date.now()}-${Math.random()}`;
  return import(`../../server/lib/state-bus.js?case=${bust}`);
}

test("run guard — one turn per cid", async (t) => {
  const bus = await freshBus();

  await t.test("a first claim succeeds and is visible", () => {
    const claim = bus.beginRun("c1", "mvs_a");
    assert.equal(claim.ok, true);
    assert.equal(bus.activeRunCount(), 1);
    const run = bus.getRunForCid("c1");
    assert.equal(run.sid, "mvs_a");
    assert.ok(run.startedAt > 0);
  });

  await t.test("a second claim on the same cid is refused", () => {
    const second = bus.beginRun("c1", "mvs_a");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "cid-busy");
    // The refusal must not have created a second slot.
    assert.equal(bus.activeRunCount(), 1);
  });

  await t.test("endRun releases the slot and the cid can claim again", () => {
    bus.endRun("c1");
    assert.equal(bus.activeRunCount(), 0);
    assert.equal(bus.getRunForCid("c1"), null);
    assert.equal(bus.beginRun("c1", "mvs_a").ok, true);
  });

  await t.test("endRun on an unheld cid is a no-op, not a throw", () => {
    bus.endRun("never-claimed");
    assert.equal(bus.activeRunCount(), 1);
  });
});

test("run guard — one turn per engine session across cids", async (t) => {
  const bus = await freshBus();

  await t.test("a second cid on the same engine session is refused", () => {
    assert.equal(bus.beginRun("tab1", "mvs_shared").ok, true);
    const other = bus.beginRun("tab2", "mvs_shared");
    assert.equal(other.ok, false);
    assert.equal(other.reason, "session-busy");
    // A different engine session is unaffected.
    assert.equal(bus.beginRun("tab2", "mvs_other").ok, true);
    assert.equal(bus.activeRunCount(), 2);
  });

  await t.test("ending one tab frees the engine session for the other", () => {
    bus.endRun("tab1");
    assert.equal(bus.beginRun("tab3", "mvs_shared").ok, true);
  });

  await t.test("a cid with no known engine session is not session-blocked", async () => {
    const bus2 = await freshBus();
    assert.equal(bus2.beginRun("a", "mvs_x").ok, true);
    // `sid: null` — the first turn of a brand-new conversation.
    assert.equal(bus2.beginRun("b", null).ok, true);
  });
});

test("run guard — MAX_CONCURRENT is a real ceiling", async (t) => {
  const { MAX_CONCURRENT } = await import("../../server/lib/config.js");
  const bus = await freshBus();

  await t.test("the advertised limit is the enforced limit", () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      assert.equal(bus.beginRun(`slot${i}`, null).ok, true, `slot ${i} should be claimable`);
    }
    assert.equal(bus.activeRunCount(), MAX_CONCURRENT);
    const over = bus.beginRun("one-too-many", null);
    assert.equal(over.ok, false);
    assert.equal(over.reason, "at-capacity");
    assert.equal(over.running, MAX_CONCURRENT);
    assert.equal(over.limit, MAX_CONCURRENT);
  });

  await t.test("freeing a slot admits the next claim", () => {
    bus.endRun("slot0");
    assert.equal(bus.beginRun("next", null).ok, true);
  });
});

test("run guard — the default cid fallback", async (t) => {
  const bus = await freshBus();
  // Requests without a cid fall back to "default" everywhere else in the
  // server; the guard must not create a second, unshared namespace for them.
  assert.equal(bus.beginRun("", "mvs_a").ok, true);
  const second = bus.beginRun(undefined, "mvs_a");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "cid-busy");
  bus.endRun("");
  assert.equal(bus.activeRunCount(), 0);
});
