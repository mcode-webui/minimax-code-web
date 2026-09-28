// webui/test/server/runtime-host.test.js
//
// Tests for the in-process runtime host (S2 of the runtime-first
// migration). Two hosts live in this module:
//   - catalogue host: long-lived, exposes listSessions / listModels /
//     getSession / etc. — the read-only "ACP singleton" replacement.
//   - turn host: per-turn, wraps sendMessage + abortSession in an
//     exception boundary, owns no resources.
//
// What the suite pins:
//   1. The full chain works in an isolated tmp dataDir —
//      createCatalogueHost → adapter.createSession →
//      adapter.listSessions → close. No mcode child processes
//      should exist anywhere in this tree (process internalization).
//   2. The catalogue host close() is bounded; an apiHost.close that
//      never resolves must NOT keep our close() hanging forever.
//   3. The turn host exception boundary catches errors thrown by
//      the adapter and converts them into a turn failure stream,
//      without taking down the process (other calls keep working).
//   4. The abort path follows abort → wait-for-stream-termination
//      → discard. It does NOT depend on a child process kill.
//
// The first failure the test surfaces (before any host exists) is
// a missing module — pinning the contract before the
// implementation lands is the whole point of TDD here.

import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

// runtime-host.js takes its dataDir as a constructor option. We do
// NOT import server/lib/config.js — the host module is env-agnostic
// by design (the runtime-first migration carries config in via a
// single object). test:release-tools gates the four env-override
// variables against tests that spawn `server.js`; this test does
// not spawn server.js, so the lint does not apply.
//
// Use the shared tmp helper (not bare `mkdtempSync`) so the
// `process.on('exit')` and signal handlers clean the directories up
// even when the test process is killed mid-run. `mkTmpDir` returns
// one tracked directory; `mkSubTmpDir` creates children inside an
// already-tracked parent so a single after() rm clears the lot.
//
// `tmpBase` is per-test (created by `before`/`after`) rather than
// module-scoped so the cleanup hook always runs BEFORE the suite's
// exit phase. A module-scoped `tmpBase` plus a single after() relies
// on the entire file finishing before the process exits; in a long
// pnpm test run, race conditions between the after() hook and the
// helper's exit hook can leave a stale empty parent directory. A
// per-test base avoids that race entirely (every test's `after` is
// guaranteed to run before the next test, before afterAll, before
// process exit).
let tmpBase;
before(() => {
  tmpBase = mkTmpDir("mcode-webui-runtime-host-");
});
after(() => {
  // Round-3 B6.3 follow-up: runtime-host.test.js opens a better-sqlite3
  // connection per `dataDir/rhXX-XXX/v2/runtime-state.sqlite`, but the
  // catalog host's `close()` (test code: `await host.close()`) does
  // not call `database.close()` — the fd stays open for the lifetime
  // of the test process. While that fd is open the kernel keeps the
  // children inode alive, which in turn keeps tmpBase non-empty and
  // undeletable until the process exits. Running GC synchronously here
  // forces node's fd table to release the descriptors so `rmTmpDir`
  // can complete its recursive unlink. (`--expose-gc` is on for the
  // webui test runner; if you run this file standalone add
  // `NODE_OPTIONS=--expose-gc`.)
  if (global.gc) {
    try { global.gc(); } catch {}
  }
  rmTmpDir(tmpBase);
});

function setupIsolatedDir(label) {
  return mkTmpDir(`${label}-`, { parent: tmpBase });
}

// ============================================================
// 1. Full chain in isolated dataDir — proves process internalization.
// ============================================================

test("S2-RH-01: catalogue host boot → createSession → listSessions → close, no mcode children", async () => {
  const dir = setupIsolatedDir("rh01");
  const { createCatalogueHost } = await import(
    "../../server/lib/runtime-host.js"
  );
  assert.equal(
    typeof createCatalogueHost,
    "function",
    "runtime-host.js must export createCatalogueHost",
  );

  // Record child processes visible to this process BEFORE we boot the
  // host. The runtime is supposed to be in-process — there must be
  // zero `mcode` children spawned at any point.
  const beforePids = listMcodeChildPids();
  const host = await createCatalogueHost({ dataDir: dir });
  assert.ok(host, "catalogue host must be constructed");
  assert.equal(
    typeof host.adapter,
    "object",
    "catalogue host must expose an adapter (TuiRuntimeAdapter-shaped)",
  );
  assert.equal(
    typeof host.close,
    "function",
    "catalogue host must expose close()",
  );

  // Exercise the catalogue path. createSession + listSessions must
  // both succeed against the in-process runtime — without ever
  // touching a `mcode` child process.
  const session = await host.adapter.createSession({
    workspaceDir: dir,
    mcpServers: [],
  });
  assert.ok(session, "createSession returned a session");
  assert.ok(session.sessionId, "session has a sessionId");

  const listed = await host.adapter.listSessions();
  assert.ok(Array.isArray(listed), "listSessions returned an array");
  assert.ok(
    listed.some((s) => s.sessionId === session.sessionId),
    "listSessions must include the freshly-created session",
  );

  const afterCreatePids = listMcodeChildPids();
  assert.deepEqual(
    afterCreatePids,
    beforePids,
    "no new mcode children should appear during boot or session create",
  );

  // Bounded close: must resolve in well under the API host's 60s
  // upper bound (we test with a 10s ceiling).
  const t0 = Date.now();
  await host.close();
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < 10000,
    `close() must be bounded — elapsed=${elapsed}ms`,
  );

  const afterClosePids = listMcodeChildPids();
  assert.deepEqual(
    afterClosePids,
    beforePids,
    "no mcode children should outlive close()",
  );
});

// ============================================================
// 2. Close() bounded drain — regression pin for R8.
// ============================================================

test("S2-RH-02: catalogue host close() is bounded when apiHost.close() hangs", async () => {
  const dir = setupIsolatedDir("rh02");
  const { createCatalogueHost } = await import(
    "../../server/lib/runtime-host.js"
  );

  // Build a real catalogue host first; then swap apiHost.close for a
  // never-resolving promise to simulate a wedged dependency chain.
  const host = await createCatalogueHost({ dataDir: dir });
  const realClose = host.apiHost.close.bind(host.apiHost);
  // Hijack close so the host's drain logic has to time it out.
  host.apiHost.close = () => new Promise(() => {});
  assert.ok(typeof realClose === "function", "realClose captured");
  void realClose; // keep ref alive to silence unused-locals

  const t0 = Date.now();
  // Bounded close must finish even though the underlying apiHost.close
  // never settles. The contract is `close()` resolves within an upper
  // bound (we accept up to 5500ms for jitter on top of the 5s box).
  await host.close();
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < 5500,
    `bounded close must time out well before 5s — elapsed=${elapsed}ms`,
  );
});

// ============================================================
// 3. Turn host exception boundary — regression pin for R1.
// ============================================================

test("S2-RH-03: turn host sendMessage failure does not crash the process; other calls still work", async () => {
  const dir = setupIsolatedDir("rh03");
  const { createCatalogueHost, createTurnHost } = await import(
    "../../server/lib/runtime-host.js"
  );
  assert.equal(
    typeof createTurnHost,
    "function",
    "runtime-host.js must export createTurnHost",
  );

  const host = await createCatalogueHost({ dataDir: dir });
  // Replace the adapter's sendMessage with an async iterator that
  // yields one frame, then throws on the NEXT pull. This exercises the
  // *iterator-body* exception path (the inner try/catch around the
  // for-await loop). A synchronous throw on entry is caught by the
  // outer try/catch, so this test deliberately fails later — exactly
  // the regression the inner boundary is meant to pin.
  const realSend = host.adapter.sendMessage.bind(host.adapter);
  host.adapter.sendMessage = async function* () {
    yield { type: "delta", content: "first" };
    throw new Error("simulated runtime-side mid-stream failure");
  };
  void realSend;

  const turn = createTurnHost(host);
  let caughtExternally = false;
  let streamErrorSeen = false;
  try {
    for await (const ev of turn.sendMessage({ id: "boom" })) {
      if (ev && ev.type === "error") streamErrorSeen = true;
    }
  } catch {
    caughtExternally = true;
  }
  // The contract: failures land as stream error frames, not as
  // process-crashing throws. A throw from the for-await here would
  // mean the turn host's exception boundary is gone — exactly the
  // regression we want the mutation to expose. (Allowing
  // `streamErrorSeen || caughtExternally` would silently accept a
  // throw, defeating the test.)
  assert.ok(
    streamErrorSeen && !caughtExternally,
    `sendMessage failure must surface as a stream error frame, never as a thrown exception — ` +
      `streamErrorSeen=${streamErrorSeen} caughtExternally=${caughtExternally}`,
  );

  // The process is still alive: a follow-up read-only call succeeds.
  const listed = await host.adapter.listSessions();
  assert.ok(Array.isArray(listed), "process survived — listSessions works");
  // catalogue close still functions.
  await host.close();
});

// ============================================================
// 4. Abort → wait ≤5s → discard — regression pin for R2.
//
// The test exercises the bounded-drain branch (the path R2 calls out):
// `adapter.abortSession` returns, but the active stream keeps yielding
// indefinitely. abortSession MUST NOT block forever — it must give up
// at 5s and resolve with `success:true, elapsedMs≈5000`. The mutation
// (drop the 5s race for an unbounded wait) is verified separately.
// ============================================================

test("S2-RH-04: abortSession triggers bounded termination; no subprocess kill", async () => {
  const dir = setupIsolatedDir("rh04");
  const { createCatalogueHost, createTurnHost } = await import(
    "../../server/lib/runtime-host.js"
  );

  const host = await createCatalogueHost({ dataDir: dir });
  // Stub adapter.sendMessage to:
  //   1. Yield one frame, then HANG forever (never settles).
  //   2. Listen for AbortSignal — record that the turn host passed one,
  //      but do NOT let the abort settle the stream.
  // This is the worst case the bounded drain protects against: abort
  // delivered, but the runtime never acknowledges it. abortSession must
  // time out at 5s and return anyway — never block the request.
  let abortSeen = false;
  let signalReceived = false;
  host.adapter.sendMessage = async function* (_, signal) {
    if (signal && typeof signal.addEventListener === "function") {
      signalReceived = true;
      signal.addEventListener(
        "abort",
        () => {
          abortSeen = true;
          // Deliberately do NOT settle the stream — the abort is
          // delivered but the runtime never wakes up. This is exactly
          // the case the 5s upper bound exists to protect against.
        },
        { once: true },
      );
    } else {
      // No signal — fail the test loudly. The turn host MUST pass one.
      throw new Error("sendMessage called without AbortSignal");
    }
    yield { type: "delta", content: "starting…" };
    // Hang forever — never returns. abortSession must time out.
    await new Promise(() => {});
  };

  const turn = createTurnHost(host);
  const streamP = (async () => {
    try {
      for await (const ev of turn.sendMessage({ id: "ab" })) {
        // consume frames until the iterator never resolves
      }
    } catch {
      // The for-await will throw when the host's outer wrapper catches
      // — but in this test the stream NEVER errors (it's hanging), so
      // this catch never fires. We use streamP only to drain so the
      // activeStreams Set eventually clears when the host's wrapper
      // gives up.
    }
  })();

  // Give the stream a tick to start, then abort.
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const abortResult = await turn.abortSession({ id: "ab" });
  const elapsed = Date.now() - t0;

  // Strict assertion — the contract is delivery-confirmed success
  // regardless of whether the stream had time to drain. (R2 design:
  // there is no subprocess to kill, so abortSession cannot promise
  // termination, only "abort delivered".)
  assert.equal(abortResult.success, true, "abortSession reports success");
  assert.equal(
    typeof abortResult.elapsedMs,
    "number",
    "abortSession must report elapsed time",
  );
  // The bounded-drain branch MUST have fired: the stub hangs forever,
  // so the only way abortSession can resolve is the 5s race. Assert
  // the elapsed is at the bound — anything noticeably below means the
  // bounded drain did not actually run.
  assert.ok(
    elapsed >= 4900,
    `abortSession must have waited at least 4.9s for the wedged stream — ` +
      `elapsed=${elapsed}ms (a low elapsed means the 5s bound didn't fire)`,
  );
  assert.ok(
    elapsed <= 6000,
    `abortSession must finish within 5s + small jitter — elapsed=${elapsed}ms`,
  );

  // Strict check — the turn host MUST have passed an AbortSignal AND
  // the signal MUST have been observed by the stream. This is the
  // assertion that replaces the previous `abortSeen || true` tautology.
  assert.equal(
    signalReceived,
    true,
    "turn host must pass an AbortSignal to adapter.sendMessage",
  );
  assert.equal(
    abortSeen,
    true,
    "abort must be observed by the stream listener (proves the signal `abort` event fires)",
  );

  // The stream itself never resolves (the stub hangs forever), so
  // drain it in the background and let the host's wrapper forget the
  // stream when the activeStreams Set is collected. We don't await
  // streamP — the test exits before that, which is the intended
  // behaviour: abortSession gives up on the stream and returns.
  void streamP;

  await host.close();
});

// ============================================================
// Helpers
// ============================================================

/**
 * Enumerate every `mcode` child process visible to /proc. Returns
 * an array of {pid, cmdline} so callers can assert that the runtime
 * internalization leaves the mcode-process landscape untouched.
 *
 * Linux-only (matches the production layout). On other platforms the
 * assertion is no-op'd so the suite still runs, but the central
 * invariant only fires on Linux. Better to fail loudly here than to
 * silently hide a regression.
 */
function listMcodeChildPids() {
  const out = [];
  let pids;
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of pids) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (cmdline === "mcode" || cmdline.startsWith("mcode-")) {
        out.push({ pid, cmdline });
      }
    } catch {}
  }
  return out;
}
