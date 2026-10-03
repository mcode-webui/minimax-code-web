// webui/test/server/host-services-window.test.js
//
// The real-host evidence for placeholder batch PB-8: the window opens
// onto a services object that is genuinely the runtime's, not a
// stand-in that happens to have the right keys.
//
// The shape and contract assertions live in
// `test/lib/engine/host-services.test.js` (fast, no boot). This file
// exists for the one claim that cannot be decided without a runtime: at
// `PB-8-SVC-01` the window hands back a live owner graph whose
// `managedWorktrees` is a real service with a callable `list`, and whose
// `cron` is honestly `undefined`.
//
// Why `cron` is asserted as undefined rather than left alone. F-13 is an
// open decision about whether the embedded CLI/TUI owner should compose
// a cron owner at all; webui boots with `runtimeOwnerKind: "tui"`, and
// `RuntimeServices.cron` is typed optional and documented as
// Electron-only. Pinning the CURRENT truth (`undefined`) is what makes
// the decision visible when it is taken: if a later batch composes cron,
// this test goes red and has to be re-read against the decision rather
// than quietly inheriting a stale expectation. The alternative — not
// asserting it — is the failure mode this batch is trying to avoid, where
// a consumer reads `services.cron` and invents an answer.
//
// Cost note, matching the sibling suite: booting the host opens a
// better-sqlite3 connection per dataDir that the host's `close()` does
// not close, so the tmp dir survives until GC runs. The teardown below
// mirrors `test/server/runtime-host.test.js` for that reason, and reuses
// its registered tmp prefix (`mcode-webui-runtime-host-`) because the
// leak profile is identical — same runtime, same fd lifetime.

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

test("PB-8-SVC-01: the window returns the booted host's real services graph", async () => {
  const dir = mkTmpDir("pb8-svc-", { parent: tmpBase });
  const { createCatalogueHost } = await import("../../server/lib/runtime-host.js");
  const { getHostServices } = await import("../../server/engine/host-services.js");

  const host = await createCatalogueHost({ dataDir: dir });

  try {
    // The pass-through itself: the provider forwarded the runtime's own
    // object, so identity holds all the way through the window. A copy
    // anywhere on this path would break it and is exactly what the
    // window's header forbids.
    const services = await getHostServices({ getHost: async () => host });
    assert.ok(services, "the window must return the services object for a booted v2 host");
    assert.equal(
      services,
      host.services,
      "the window must forward the host's own object by reference",
    );

    // The evidence PB-3 is waiting for: a real worktree service with a
    // real method, not a placeholder that answers [] for every query.
    assert.equal(
      typeof services.managedWorktrees,
      "object",
      "services.managedWorktrees must be composed — PB-3 lists worktrees through it",
    );
    assert.equal(
      typeof services.managedWorktrees.list,
      "function",
      "services.managedWorktrees.list must be callable — a stub here would be the fake success #110 exists to prevent",
    );

    // The other half of the PB-3 contract, asserted against the runtime
    // rather than against a string. A stub that answered `{success:true,
    // worktrees:[]}` for every input would pass an "is it an array" check
    // while being the fake success #110 exists to prevent; what
    // distinguishes the real service is that it ran git and reported an
    // honest reason for a directory that is not a repository — the exact
    // contract PB-3 §3.5 pins.
    const listed = await services.managedWorktrees.list(dir);
    assert.equal(typeof listed.success, "boolean", "list must answer the result envelope");
    assert.ok(Array.isArray(listed.worktrees), "list must always carry a worktrees array");
    assert.equal(
      listed.success,
      false,
      "the tmp dir is not a git repository — the real service must say so",
    );
    assert.ok(
      typeof listed.code === "string" && listed.code.length > 0,
      "a non-repository must come back with a discovery code, not a silent empty list",
    );

    // F-13: honest absence. See the header — this is pinned so the
    // decision has to be taken out loud.
    assert.equal(
      services.cron,
      undefined,
      "services.cron is Electron-only (services.ts) and webui boots runtimeOwnerKind:'tui' — a cron owner appearing here means F-13 was decided and this expectation must be re-read",
    );
  } finally {
    await host.close();
  }
});

test("PB-8-SVC-02: the provider forwards services, and a host without one stays undefined", async () => {
  const { createCatalogueHost } = await import("../../server/lib/runtime-host.js");
  const { getHostServices } = await import("../../server/engine/host-services.js");

  const dir = mkTmpDir("pb8-svc-shape-", { parent: tmpBase });
  const host = await createCatalogueHost({ dataDir: dir });
  try {
    // Independent of the window: the provider module is the only place
    // that could drop the member on the way out of the runtime.
    assert.ok("services" in host, "createCatalogueHost must forward the runtime's services member");
  } finally {
    await host.close();
  }

  // And the three-way answer, against a host object shaped the way a
  // non-V2 embedder's would be.
  assert.equal(await getHostServices({ getHost: async () => null }), null);
  assert.equal(await getHostServices({ getHost: async () => ({}) }), undefined);
});
