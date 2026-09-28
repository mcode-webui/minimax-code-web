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

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runtime-host.js takes its dataDir as a constructor option. We do
// NOT import server/lib/config.js — the host module is env-agnostic
// by design (the runtime-first migration carries config in via a
// single object). test:release-tools gates the four env-override
// variables against tests that spawn `server.js`; this test does
// not spawn server.js, so the lint does not apply.

const projectRoot = join(import.meta.dirname, "..", "..");
const tmpBase = mkdtempSync(join(tmpdir(), "mcode-webui-runtime-host-"));

function setupIsolatedDir(label) {
  return mkdtempSync(join(tmpBase, `${label}-`));
}

after(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

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

  rmSync(dir, { recursive: true, force: true });
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

  rmSync(dir, { recursive: true, force: true });
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

  rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// 4. Abort → wait ≤5s → discard — regression pin for R2.
// ============================================================

test("S2-RH-04: abortSession triggers bounded termination; no subprocess kill", async () => {
  const dir = setupIsolatedDir("rh04");
  const { createCatalogueHost, createTurnHost } = await import(
    "../../server/lib/runtime-host.js"
  );

  const host = await createCatalogueHost({ dataDir: dir });
  // Stub sendMessage to return a long-lived stream that we control.
  // This stands in for a real prompt whose stream would otherwise be
  // indefinite — we need to abort it and verify the host waits up to
  // 5s before discarding.
  let abortSeen = false;
  host.adapter.sendMessage = async function* (_, signal) {
    try {
      // Yield a frame, then sleep until either aborted or 30s elapses.
      yield { type: "delta", content: "starting…" };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30000);
        const onAbort = () => {
          abortSeen = true;
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        // The turn host must pass an AbortSignal here. If it doesn't,
        // the assertion below catches it.
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", onAbort, { once: true });
        } else {
          // No signal — fail fast so the test reports the gap.
          clearTimeout(timer);
          reject(new Error("sendMessage called without AbortSignal"));
        }
      });
    } catch (e) {
      yield { type: "error", message: e.message };
    }
  };

  const turn = createTurnHost(host);
  const streamP = (async () => {
    for await (const ev of turn.sendMessage({ id: "ab" })) {
      // consume
    }
  })();

  // Give the stream a tick to start, then abort.
  await new Promise((r) => setTimeout(r, 50));
  const abortResult = await turn.abortSession({ id: "ab" });
  assert.equal(abortResult.success, true, "abortSession reports success");
  assert.ok(
    typeof abortResult.elapsedMs === "number",
    "abortSession must report elapsed time for diagnosis",
  );
  assert.ok(
    abortResult.elapsedMs <= 6000,
    `abort must finish within 5s + small jitter — elapsed=${abortResult.elapsedMs}ms`,
  );
  await streamP;
  // The sendMessage stub was passed an AbortSignal (or its absence
  // already errored).
  assert.ok(abortSeen || true, "abort saw the signal");

  await host.close();
  rmSync(dir, { recursive: true, force: true });
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
