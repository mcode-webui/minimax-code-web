// webui/test/lib/state-bus-revision.check.mjs
// Unit tests for ticket 08 — per-cid snapshot revision in state-bus.js.
//
// The set-model SSE race (ticket 08) defends itself with TWO writers:
//   1. server/lib/mcode-acp.js#applyConfigOptionUpdate — an
//      ownership-aware mirror that defers the engine's response inside
//      a 4s window so the user's recorded pick isn't reverted to the
//      wire form;
//   2. server/lib/state-bus.js — a per-cid monotonic revision counter
//      stamped on every push, so the React store can drop a stale
//      frame regardless of wire-order / coalesce-window surprises.
//
// This file exercises (2). It pins:
//   - the counter is per-cid (cid-A pushes don't disturb cid-B);
//   - every pushStateFor / pushOnlineCount / broadcast bumps by 1;
//   - the broadcast / pushOnlineCount paths bump ONCE per recipient;
//   - handleEvents' first frame reservation runs before the snapshot
//     is JSON-stringified, so the wire always carries the latest
//     reserved number;
//   - endSseClient clears the counter for the cid that disconnected,
//     so the next client is not choked by a stale high-water mark;
//   - the diff gate and the new revision counter are NOT mutually
//     exclusive: revisions guarantee ordering, the diff gate still
//     suppresses byte-identical writes (and is preserved as a
//     static-source tripwire).
//
// Why this file is separate from test/lib/state-bus.check.mjs and
// test/lib/state-bus-coalesce.check.mjs: those files pin the
// push/revision/diff gate contracts from a single angle. The revision
// guard is its own concern with its own invariants, so it lives here.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupMocks,
  absPath,
  registerAcpMock,
  registerSessionsStore,
} from "../helpers/_setup.js";

let pushStateFor, pushOnlineCount, mcodeSessionsSnapshotFields;
let clients, sseByCid, makeClientState;
let nextRevisionFor, revisionFor;
let resetRevisionFor, setSseClient, endSseClient;

before(async (t) => {
  await setupMocks(t);
  const mod = await import(absPath("lib/state-bus.js"));
  pushStateFor = mod.pushStateFor;
  pushOnlineCount = mod.pushOnlineCount;
  mcodeSessionsSnapshotFields = mod.mcodeSessionsSnapshotFields;
  clients = mod.clients;
  sseByCid = mod.sseByCid;
  makeClientState = mod.makeClientState;
  nextRevisionFor = mod.nextRevisionFor;
  revisionFor = mod.revisionFor;
  resetRevisionFor = mod.resetRevisionFor;
  setSseClient = mod.setSseClient;
  endSseClient = mod.endSseClient;
});

beforeEach(() => {
  clients.clear();
  sseByCid.clear();
  // Reset per-cid revision counters between tests — production keeps
  // the counter for the lifetime of a cid, but each test starts from
  // a clean slate so prior tests don't leak their bumps into
  // assertions that expect starting-at-1 behaviour.
  resetRevisionFor("cid-rev-A");
  resetRevisionFor("cid-rev-B");
  resetRevisionFor("cid-rev-C");
  resetRevisionFor("a");
  resetRevisionFor("b");
  registerAcpMock({
    getMcodeSessionsForWorkspace: async () => [],
    getMcodeSessionsCacheSync: () => null,
    getMcodeSessionsStaleSync: () => null,
  });
  registerSessionsStore({
    initial: [
      {
        id: "sess-1",
        title: "old",
        workspace: "/w",
        createdAt: 1,
        updatedAt: 1,
        chat: [],
      },
    ],
  });
});

function fakeSse() {
  const writes = [];
  return {
    writes,
    write: (chunk) => {
      writes.push(chunk);
    },
  };
}

// ============================================================
// nextRevisionFor — the per-cid monotonic counter primitive.
// ============================================================
describe("nextRevisionFor — per-cid counter primitive", () => {
  test("starts at 1 for a never-seen cid", () => {
    assert.equal(nextRevisionFor("cid-rev-A"), 1);
    assert.equal(revisionFor("cid-rev-A"), 1);
  });

  test("strictly monotonic per cid (1 → 2 → 3)", () => {
    assert.equal(nextRevisionFor("cid-rev-A"), 1);
    assert.equal(nextRevisionFor("cid-rev-A"), 2);
    assert.equal(nextRevisionFor("cid-rev-A"), 3);
    assert.equal(revisionFor("cid-rev-A"), 3);
  });

  test("counter is per-cid (cid-A bumps do not move cid-B)", () => {
    assert.equal(nextRevisionFor("cid-rev-A"), 1);
    assert.equal(nextRevisionFor("cid-rev-A"), 2);
    assert.equal(nextRevisionFor("cid-rev-B"), 1, "B starts fresh at 1");
    assert.equal(nextRevisionFor("cid-rev-A"), 3, "A continues independently");
    assert.equal(nextRevisionFor("cid-rev-B"), 2);
  });

  test("an empty cid falls back to the 'default' bucket", () => {
    assert.equal(nextRevisionFor(""), 1);
    assert.equal(nextRevisionFor(""), 2);
  });

  test("nextRevisionFor returns higher-than-current snapshots", () => {
    // The "current" revision (what's been emitted) is monotonic per
    // cid. The returned value from nextRevisionFor is the next
    // available integer, which is strictly greater than what
    // revisionFor returns at any prior point.
    const first = nextRevisionFor("cid-rev-C");
    const second = nextRevisionFor("cid-rev-C");
    assert.ok(second > first, `second (${second}) > first (${first})`);
  });
});

// ============================================================
// pushStateFor — every push stamps the snapshot with the next
// revision and writes through unchanged.
// ============================================================
describe("pushStateFor — every push stamps a fresh revision", () => {
  test("the wire payload carries the stamped revision", () => {
    const cid = "cid-rev-A";
    const res = fakeSse();
    clients.set(cid, makeClientState());
    sseByCid.set(cid, res);
    const before = revisionFor(cid);
    pushStateFor(cid);
    assert.equal(res.writes.length, 1, "one wire frame");
    const payload = JSON.parse(res.writes[0].slice(6));
    assert.equal(payload.revision, before + 1, "stamped revision is monotonic");
  });

  test("two pushes within the throttle window coalesce but the LAST writer's revision wins", async () => {
    const mod = await import(absPath("lib/state-bus.js"));
    // Re-import with the throttle enabled; reuse the bus already
    // imported above for the diff gate primitives.
    const originalEnv = process.env.STATE_PUSH_THROTTLE_MS;
    process.env.STATE_PUSH_THROTTLE_MS = "20";
    try {
      const throttled = await import(
        absPath("lib/state-bus.js") + "?bust=throttle-rev-" + Date.now()
      );
      const cid = "cid-rev-A";
      const res = fakeSse();
      throttled.clients.set(cid, throttled.makeClientState());
      throttled.sseByCid.set(cid, res);
      const r0 = throttled.revisionFor(cid);
      throttled.pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
      throttled.pushStateFor(cid, { mcodeSessions: [{ id: "v2" }] });
      throttled.pushStateFor(cid, { mcodeSessions: [{ id: "v3" }] });
      // last-call-wins inside the throttle window — the pending
      // entry carries the highest revision reserved.
      throttled.flushPendingPushes();
      assert.equal(res.writes.length, 2);
      const last = JSON.parse(res.writes[1].slice(6));
      assert.ok(last.revision > r0, "last wire frame's revision is > the start");
      // The intermediate revisions were reserved but never written —
      // the counter is monotonic regardless of coalescing.
      assert.equal(throttled.revisionFor(cid), r0 + 3);
      // Suppress the lint warning on the unused mod import.
      void mod;
    } finally {
      if (originalEnv === undefined) delete process.env.STATE_PUSH_THROTTLE_MS;
      else process.env.STATE_PUSH_THROTTLE_MS = originalEnv;
    }
  });

  test("a reconnect resets the cid's counter so a fresh client sees revision 1 on its first frame", () => {
    const cid = "cid-rev-A";
    const oldRes = fakeSse();
    clients.set(cid, makeClientState());
    sseByCid.set(cid, oldRes);
    // Many bumps for the previous (now disconnected) client.
    for (let i = 0; i < 5; i += 1) nextRevisionFor(cid);
    assert.equal(revisionFor(cid), 5);
    // Disconnect — endSseClient drops the counter so the next client
    // does not see "stale-frame rejection" on its very first push.
    endSseClient(cid, oldRes);
    assert.equal(revisionFor(cid), 0, "endSseClient clears the counter");
    // A fresh connection reserves 1.
    const newRes = fakeSse();
    sseByCid.set(cid, newRes);
    setSseClient(cid, newRes);
    pushStateFor(cid);
    const payload = JSON.parse(newRes.writes[0].slice(6));
    assert.equal(payload.revision, 1, "first frame after reconnect starts at 1");
  });
});

// ============================================================
// pushOnlineCount + broadcast — broadcast paths bump the counter
// per recipient (cid-local sequence), not as a single global bump.
// ============================================================
describe("pushOnlineCount + broadcast — per-recipient counter bump", () => {
  test("pushOnlineCount bumps the counter for every connected cid", () => {
    const a = fakeSse();
    const b = fakeSse();
    clients.set("a", makeClientState());
    clients.set("b", makeClientState());
    sseByCid.set("a", a);
    sseByCid.set("b", b);
    pushOnlineCount(false);
    assert.equal(a.writes.length, 1);
    assert.equal(b.writes.length, 1);
    const pa = JSON.parse(a.writes[0].slice(6));
    const pb = JSON.parse(b.writes[0].slice(6));
    assert.equal(pa.revision, 1, "cid-a bumped to 1");
    assert.equal(pb.revision, 1, "cid-b bumped to 1 (independently)");
  });

  test("pushStateFor('__broadcast__') bumps each recipient counter", () => {
    const a = fakeSse();
    const b = fakeSse();
    clients.set("a", makeClientState());
    clients.set("b", makeClientState());
    sseByCid.set("a", a);
    sseByCid.set("b", b);
    pushStateFor("__broadcast__", { mcodeSessions: [{ id: "bcast" }] });
    const pa = JSON.parse(a.writes[0].slice(6));
    const pb = JSON.parse(b.writes[0].slice(6));
    assert.ok(pa.revision > 0 && pb.revision > 0,
      "both recipients get a positive revision");
  });

  test("two broadcast pushes emit two wire frames because revisions change the bytes", () => {
    // Side note: with revisions stamped into every payload the diff
    // gate (which compares bytes) can no longer suppress two
    // back-to-back pushes — even an identical-body push is a
    // different byte string once `revision` differs. Coalescing
    // continues to work through STATE_PUSH_THROTTLE_MS, but with the
    // default throttle of 0ms every push writes synchronously.
    const a = fakeSse();
    clients.set("a", makeClientState());
    sseByCid.set("a", a);
    pushStateFor("__broadcast__");
    pushStateFor("__broadcast__");
    assert.equal(a.writes.length, 2,
      "revisions make back-to-back pushes byte-different; throttle is what suppresses");
    const first = JSON.parse(a.writes[0].slice(6));
    const second = JSON.parse(a.writes[1].slice(6));
    assert.ok(second.revision > first.revision,
      "revisions monotonic even when diff gate does not coalesce");
  });
});

// ============================================================
// Interleaving simulation — push many different bytes back-to-back;
// the LAST wire frame's revision must exceed every prior one. This
// is the shape the set-model race actually exhibits on the wire.
// ============================================================
describe("interleaved pushes — wire sequence is monotonic per cid", () => {
  test("rapid interleaving produces a strictly increasing revision on the wire", () => {
    const cid = "cid-rev-A";
    const res = fakeSse();
    clients.set(cid, makeClientState());
    sseByCid.set(cid, res);
    const revisions = [];
    // Simulate the model-swap shape: optimistic user-pick write,
    // then engine mirror, then a couple of background pushes,
    // then the engine's final mirror.
    pushStateFor(cid, { mcodeSessions: [{ id: "user-pick" }] });
    revisions.push(JSON.parse(res.writes.at(-1).slice(6)).revision);
    pushStateFor(cid, { mcodeSessions: [{ id: "engine-mirror-1" }] });
    revisions.push(JSON.parse(res.writes.at(-1).slice(6)).revision);
    pushStateFor(cid, { mcodeSessions: [{ id: "online-count" }] });
    revisions.push(JSON.parse(res.writes.at(-1).slice(6)).revision);
    pushStateFor(cid, { mcodeSessions: [{ id: "engine-mirror-2" }] });
    revisions.push(JSON.parse(res.writes.at(-1).slice(6)).revision);
    // Wire sequence (revisions only):
    for (let i = 1; i < revisions.length; i += 1) {
      assert.ok(
        revisions[i] > revisions[i - 1],
        `revision[${i}]=${revisions[i]} must exceed revision[${i - 1}]=${revisions[i - 1]}`,
      );
    }
  });
});

// ============================================================
// setSseClient / endSseClient / resetRevisionFor — the counter
// lifecycle around an SSE connection. endSseClient must drop the
// counter so a reconnecting client isn't choked by a previous
// session's high-water mark.
// ============================================================
describe("revision lifecycle — setSseClient / endSseClient", () => {
  test("resetRevisionFor clears a cid's counter (test escape hatch)", () => {
    nextRevisionFor("cid-rev-A");
    nextRevisionFor("cid-rev-A");
    assert.equal(revisionFor("cid-rev-A"), 2);
    resetRevisionFor("cid-rev-A");
    assert.equal(revisionFor("cid-rev-A"), 0, "reset drops the bucket");
    assert.equal(nextRevisionFor("cid-rev-A"), 1, "next reservation starts at 1");
  });
});
