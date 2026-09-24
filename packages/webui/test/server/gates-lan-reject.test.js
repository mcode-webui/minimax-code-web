// webui/test/server/gates-lan-reject.test.js
// Regression test for the LAN-reject gate (gates.js#runGates gate 2).
//
// Why this exists: when the gate chain was refactored into a single function
// with a boolean return (true = "a gate has answered, caller must stop"),
// gate 2 was wired as `if (rejectLan(...)) return;` — which evaluates to
// `return undefined`. The contract is "true stops the request"; undefined is
// falsy, so the Hono caller treated it as "no gate answered", awaited next(),
// and let the route handler write a real 200 on top of the gate's 403 —
// a security regression where LAN sharing off would still serve the
// underlying data after a 403/200 splice.
//
// The bug survives any single-gate test: the route unit tests run on loopback,
// so gate 2 is skipped and the verdict is right by accident. This file exercises
// the gate chain the way the Hono layer does: remote socket, LAN off, real
// app.request().

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createHonoApp } from "../../server/app.js";
import { runGates } from "../../server/lib/gates.js";
import {
  setLanBroadcast,
  setReadOnly,
} from "../../server/lib/settings.js";
import { setupMocks } from "../helpers/_setup.js";

before(async (t) => {
  await setupMocks(t, {});
});

after(() => {
  setLanBroadcast(true);
  setReadOnly(false);
});

/** Minimal Node-request stand-in: only what `runGates` reads. */
function fakeIncoming({ method = "GET", url = "/api/sessions", remoteAddress = "8.8.8.8" } = {}) {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress },
  };
}

describe("runGates — gate 2 LAN reject", () => {
  test("LAN off + non-local request: gate returns true (true, not undefined)", () => {
    setLanBroadcast(false);
    const verdict = runGates(fakeIncoming({ remoteAddress: "8.8.8.8" }), mockRes(), "/api/sessions");
    assert.equal(verdict, true, `expected true, got ${String(verdict)} (${typeof verdict})`);
  });

  test("LAN off + non-local request: Hono layer returns 403, not 403+200 splice", async () => {
    setLanBroadcast(false);
    const app = createHonoApp();
    const res = await app.request(
      "/api/sessions",
      {},
      { incoming: fakeIncoming({ remoteAddress: "8.8.8.8" }) },
    );
    assert.equal(res.status, 403);
    const body = await res.text();
    assert.match(body, /LAN access disabled/);
    // The body must be exactly the LAN rejection — a single JSON object, not
    // two glued together.
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, false);
  });

  test("LAN on + non-local request: gate returns false (let the request through)", () => {
    setLanBroadcast(true);
    const verdict = runGates(fakeIncoming({ remoteAddress: "8.8.8.8" }), mockRes(), "/api/sessions");
    assert.equal(verdict, false);
  });

  test("LAN off + local request: gate returns false (loopback exemption)", () => {
    setLanBroadcast(false);
    const verdict = runGates(fakeIncoming({ remoteAddress: "127.0.0.1" }), mockRes(), "/api/sessions");
    assert.equal(verdict, false);
  });
});

/**
 * A response stand-in that records what was written and concatenates bodies.
 * Used by the direct (non-Hono) gate test — the Hono path uses a real fetch.
 */
function mockRes() {
  const state = { status: null, chunks: [], headersSent: false };
  return {
    get headersSent() {
      return state.headersSent;
    },
    setHeader() {},
    writeHead(status, _headers) {
      state.status = status;
      state.headersSent = true;
      return this;
    },
    write(chunk) {
      state.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(String(chunk));
      return this;
    },
  };
}