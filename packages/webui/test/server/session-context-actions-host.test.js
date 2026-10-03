// webui/test/server/session-context-actions-host.test.js
//
// The real-host evidence for placeholder batch PB-1: the four session
// right-click actions reach REAL engine methods on a BOOTED host.
//
// The gate, the three-state handling and the pure derivations live in
// `test/lib/engine/session-context-actions.test.js` (fast, no boot,
// injected host). This file exists for the one claim that cannot be
// decided without a runtime:
//
//   1. `host.cliService` really carries `archiveSession`,
//      `getSessionForkOptions` and `forkSession` — the three methods the
//      menu's live items call. A facade test with a fake host proves the
//      facade calls what it says; only this proves what it says EXISTS.
//   2. `host.services.pinService` really carries `pinSession` and
//      `getOrder`, on the SAME host, at the SAME path the three-state
//      resolver walks. This is the one that matters most for PB-1: pin
//      is the family's only member read through the PB-8 window rather
//      than through `cliService`, and the path it walks
//      (`host.services.pinService.pinSession`) is exactly the kind of
//      string that is wrong in a way no fake-host test can see.
//   3. `readEnginePinnedSessionOrder()` against the real host does NOT
//      degrade — which is the difference between "the overlay works" and
//      "the overlay silently returns [] on every tree read".
//
// What is deliberately NOT asserted. No session is archived, pinned or
// forked here. These are WRITES against a real store, and a test whose
// side effect is a row in the engine's database is a test that changes
// the state the next assertion reads. The existence and shape of the
// methods is the contract this batch owns; their behaviour under a real
// id belongs with the engine's own suite, which is where
// `lifecycle-application.ts#archiveSession` and the fork workflow are
// already covered.
//
// Cost note, matching the sibling suite: booting the host opens a
// better-sqlite3 connection per dataDir that the host's `close()` does
// not close, so the tmp dir survives until GC runs. The teardown below
// mirrors `test/server/host-services-window.test.js` for that reason and
// reuses its registered tmp prefix, because the leak profile is
// identical — same runtime, same fd lifetime.

import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";

import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmpBase;
before(() => {
  tmpBase = mkTmpDir("mcode-webui-runtime-host-");
});
after(() => {
  if (global.gc) {
    try { global.gc(); } catch { /* best effort */ }
  }
  rmTmpDir(tmpBase);
});

test("PB-1-HOST-01: the four actions reach real methods on a booted host", async () => {
  const dir = mkTmpDir("pb1-host-", { parent: tmpBase });
  const { createCatalogueHost } = await import("../../server/lib/runtime-host.js");

  const host = await createCatalogueHost({ dataDir: dir });
  try {
    // --- the three cliService members ---------------------------------
    // These are the methods the three live menu items call. Asserted by
    // name against the REAL surface, because the capability declaration
    // that gates them (`sessionCrud: full` in
    // `local-runtime-v2.capabilities.js`) is a static claim and this is
    // the mechanical check that the claim is true. The snapshot audit
    // (test/lib/engine/capability-snapshot.test.js:345) asserts the same
    // methods; this file asserts the same methods THROUGH PB-1's own
    // declaration table, so a divergence between the two is visible here
    // rather than in whichever suite runs second.
    for (const method of ["archiveSession", "getSessionForkOptions", "forkSession"]) {
      assert.equal(
        typeof host.cliService?.[method],
        "function",
        `host.cliService.${method} must be callable — a missing member here is a 501 on a menu item this batch unlocked`,
      );
    }

    // --- the pin member, through the PB-8 window ----------------------
    // The path is the load-bearing part. `resolveContextActionMember`
    // walks `host` (not `host.services`) with the dotted string
    // `services.pinService`, after checking the window's own three
    // states. A unit test with a fake host cannot see a path that is
    // wrong in a uniform way; this one can, and did: the first
    // implementation walked the path from the window and answered 501 for
    // a member that was right there.
    const services = host.services;
    assert.ok(services, "a booted v2 host must carry an owner graph");
    assert.equal(typeof services.pinService, "object", "services.pinService must be composed");
    assert.equal(
      typeof services.pinService.pinSession,
      "function",
      "services.pinService.pinSession must be callable — the pin menu item resolves through exactly this member",
    );
    assert.equal(
      typeof services.pinService.getOrder,
      "function",
      "services.pinService.getOrder must be callable — the sidebar's pin overlay reads through exactly this method",
    );

    // --- the overlay does not degrade against a real host ------------
    // The absence of this assertion is what would let the overlay ship
    // as a permanent no-op: `readEnginePinnedSessionOrder` degrades by
    // design, so a path that always returns `{pinnedIds: [], degraded:
    // true}` is a PASSING implementation with no pins on screen. On a
    // real host nothing is pinned yet, so the honest answer is
    // `degraded: false` with an empty list — and that is the pair that
    // distinguishes "the engine said nothing is pinned" from "we could
    // not ask".
    const { readEnginePinnedSessionOrder } = await import(
      "../../server/engine/session-context-actions.js"
    );
    const order = await readEnginePinnedSessionOrder({ getHost: async () => host });
    assert.equal(
      order.degraded,
      false,
      `the pin read must not degrade against a real host (reason: ${order.reason}) — a permanent degrade is a permanent no-op overlay`,
    );
    assert.deepEqual(order.pinnedIds, [], "a fresh data dir has nothing pinned");
  } finally {
    await host.close();
  }
});
