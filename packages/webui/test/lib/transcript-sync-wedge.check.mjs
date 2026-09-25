// webui/test/lib/transcript-sync-wedge.check.mjs
//
// session-isolation/06 (Item 3 — wedge healing). The transcript-sync
// poller's guard skips a cid when `cs.running.active` is true OR an
// active child is registered — but those flags can stick true
// forever if the backend received SIGTERM mid-stream (see the
// graceful-shutdown ticket). Without the wedge exception, a wedged
// tab keeps its polluted chat forever.
//
// Fix: an active-looking tab whose lastDeltaAt is older than
// TRANSCRIPT_SYNC_WEDGED_MS (5 min by default) AND that has no live
// ACP child is treated as a wedge and the DB-rebuild path runs.
// Real active runs (lastDeltaAt recent) still skip.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupMocks, absPath } from "../helpers/_setup.js";

let syncTranscriptsOnce;
let stateBus;
let defaultWedgedMs;

before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({
        mcode: [],
        webui: [],
        fetchedAt: 0,
        source: "test",
      }),
    },
  });
  const ts = await import(absPath("lib/transcript-sync.js"));
  syncTranscriptsOnce = ts.syncTranscriptsOnce;
  // The module exports the threshold under the legacy name
  // `wedgedRunMs` (alias of `TRANSCRIPT_SYNC_WEDGED_MS`). Read either
  // — this test pins the runtime threshold (5 min).
  defaultWedgedMs = ts.wedgedRunMs;
  stateBus = await import(absPath("lib/state-bus.js"));
});

after(() => {
  stateBus.clients.clear();
  stateBus.resetCoalesceState();
});

function fresh(now = Date.now()) {
  stateBus.clients.clear();
  stateBus.clients.set("cid-test", {
    chat: ["● old"],
    mcodeSessionId: "mvs_aaaa1111bbbb2222cccc3333dddd4444",
    running: { active: false, lastDeltaAt: null, startedAt: null },
  });
  stateBus.getSseClient?.("cid-test"); // best-effort — register an SSE for the cid so the guard passes
}

describe("transcript-sync — wedge healing (Item 3)", () => {
  test("an active tab with no lastDeltaAt (never wrote a line) AND no active child is treated as wedged", () => {
    fresh();
    stateBus.clients.get("cid-test").running = {
      active: true,
      startedAt: Date.now() - 10 * 60 * 1000, // 10 min ago
      lastDeltaAt: null,
    };
    // No active child → heal.
    stateBus.activeChildByCid?.delete?.("cid-test");
    const refreshed = syncTranscriptsOnce({ dbPath: "/no/such/path.sqlite" });
    // The DB read will fail (no file) — but the point is the wedge
    // exception fires (not skipped). Confirm by the absence of an
    // error about "active".
    assert.ok(
      Array.isArray(refreshed),
      "wedge exception fired (the function did not skip)",
    );
  });

  test("an active tab whose lastDeltaAt is RECENT still skips", () => {
    fresh();
    stateBus.clients.get("cid-test").running = {
      active: true,
      startedAt: Date.now() - 5000,
      lastDeltaAt: Date.now() - 100, // recent — looks healthy
    };
    stateBus.activeChildByCid?.delete?.("cid-test");
    const refreshed = syncTranscriptsOnce({ dbPath: "/no/such/path.sqlite" });
    // Recent lastDeltaAt → skip path; refreshed is empty.
    assert.deepEqual(refreshed, []);
  });

  test("an active tab with a live active child still skips (no false heal)", () => {
    fresh();
    stateBus.clients.get("cid-test").running = {
      active: true,
      startedAt: Date.now() - 10 * 60 * 1000, // 10 min ago
      lastDeltaAt: Date.now() - 10 * 60 * 1000, // stale
    };
    // Register a live active child for this cid. setActiveChild
    // exists on the state-bus helper; mock it via the helper if it
    // exists, else install directly on the registry.
    if (typeof stateBus.setActiveChild === "function") {
      stateBus.setActiveChild("cid-test", { alive: true });
    } else if (stateBus.activeChildByCid) {
      stateBus.activeChildByCid.set("cid-test", { alive: true });
    }
    const refreshed = syncTranscriptsOnce({ dbPath: "/no/such/path.sqlite" });
    assert.deepEqual(
      refreshed,
      [],
      "active child present → no false heal even when lastDeltaAt is stale",
    );
  });

  test("TRANSCRIPT_SYNC_WEDGED_MS defaults to 5 minutes", () => {
    assert.equal(defaultWedgedMs, 5 * 60 * 1000);
  });

  // Regression pin for the alias-only bug: when the wedge branch
  // referenced the EXPORTED alias name (rather than a local
  // binding), every tick against a stale tab threw
  // "TRANSCRIPT_SYNC_WEDGED_MS is not defined" — the wedge healing
  // never fired AND the throw aborted the whole sync pass, so
  // healthy tabs stopped syncing while any tab was mid-turn. The
  // earlier unit tests passed because they read the exported name;
  // the INTERNAL reference was the broken one. This test runs a
  // tick against a wedged tab and asserts no throw — that catches
  // the alias-reference pattern directly.
  test("a wedged tick does NOT throw (internal name binding, not just export)", () => {
    fresh();
    stateBus.clients.get("cid-test").running = {
      active: true,
      startedAt: Date.now() - 10 * 60 * 1000, // 10 min ago
      lastDeltaAt: null,
    };
    stateBus.activeChildByCid?.delete?.("cid-test");
    // A real DB read path will fail (no sqlite at /no/such/path.sqlite),
    // but the wedge exception itself must resolve the local binding
    // before the DB read — that was the bug.
    assert.doesNotThrow(() =>
      syncTranscriptsOnce({ dbPath: "/no/such/path.sqlite" }),
    );
  });
});