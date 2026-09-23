// webui/test/server/app-hono.test.js
// Tests for the Hono application layer: the migration ledger, the response capture the
// gate chain writes into, and parity with the legacy dispatcher for a migrated route.
//
// The parity assertions are the point. The whole risk of a strangler is that the new
// layer answers *slightly* differently from the old one — a dropped CORS header is
// invisible until a browser refuses to read a response.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import {
  OWNED_ROUTES,
  createHonoApp,
  createResponseCapture,
  ownsRequest,
} from "../../server/app.js";
import * as healthRoute from "../../server/routes/health.js";

/** Minimal Node-request stand-in: only what `runGates` reads. */
function fakeIncoming({ method = "GET", url = "/api/health", origin, remoteAddress = "127.0.0.1" } = {}) {
  return {
    method,
    url,
    headers: origin ? { origin } : {},
    socket: { remoteAddress },
  };
}

/** Run the legacy health handler and return its captured status/headers/body. */
function legacyHealth() {
  const capture = createResponseCapture();
  healthRoute.handleHealth(fakeIncoming(), capture);
  return capture.result();
}

describe("app.js — migration ledger", () => {
  test("owns exactly the migrated routes", () => {
    // Set order is insertion order (ES2015+), but deepEqual on arrays compares
    // structurally — order matters here because the ledger is also a checklist:
    // any future hand-edit that reorders entries still proves the set is correct.
    assert.deepEqual([...OWNED_ROUTES], [
      "GET /api/health",
      "GET /api/state",
      "GET /api/sessions",
      "POST /api/sessions",
      "POST /api/sessions/switch",
      "POST /api/sessions/rename",
      "GET /api/sessions/search",
      "POST /api/sessions/cleanup-orphans",
      "DELETE /api/sessions/:id",
      "GET /api/session-tree",
      "GET /api/acp-sessions",
      "GET /api/acp-session-title",
      "GET /api/sessions/:id/export",
      "POST /api/send",
      "POST /api/stop",
      "POST /api/cmd",
      "POST /api/usage",
      "POST /api/usage-trigger",
      "GET /api/usage-real",
      "POST /api/refresh",
      "GET /api/usage/forecast",
      "POST /api/workspace",
      "GET /api/workspace/browse",
      "GET /api/workspace/tree",
      "GET /api/workspace/resolve",
      "GET /api/workspace/recent",
      "POST /api/workspace/pick",
      "GET /api/fs/read",
      "POST /api/fs/mkdir",
      "GET /api/settings",
      "POST /api/settings",
      "POST /api/auth/decision",
      "POST /api/upload",
      "GET /api/models",
      "POST /api/set-model",
      "POST /api/permissions",
      "GET /api/permissions-modes",
      "POST /api/answer",
      "POST /api/debug/inject",
      "GET /api/debug/state",
      "POST /api/protocol/set-mode",
      "POST /api/protocol/set-config-option",
      "POST /api/protocol/cancel",
      "POST /api/protocol/load-session",
      "POST /api/protocol/activate-session",
      "GET /api/protocol/list-sessions",
      "GET /api/protocol/capabilities",
    ]);
  });

  test("is method-sensitive, so a POST to a migrated path stays on the legacy layer", () => {
    assert.equal(ownsRequest("GET", "/api/health"), true);
    assert.equal(ownsRequest("POST", "/api/health"), false);
    // POST /api/sessions is migrated; DELETE /api/sessions (without a :id
    // suffix) is not a real route, so the matcher must reject it.
    assert.equal(ownsRequest("DELETE", "/api/sessions"), false);
  });

  test("parameterised routes match by pattern", () => {
    // The Hono app's own router table drives `ownsRequest`, so the literal
    // pathname coming off the wire resolves against `:id` placeholders.
    assert.equal(ownsRequest("DELETE", "/api/sessions/abc"), true);
    assert.equal(ownsRequest("GET", "/api/sessions/abc/export"), true);
    // Different verb on the same shape is fine too (Hono's router keeps
    // method-specific tries).
    assert.equal(ownsRequest("GET", "/api/sessions/abc"), false);
    // A bare `/api/sessions/` (trailing slash, no id) is not a real
    // session id and must fall through to the legacy dispatcher.
    assert.equal(ownsRequest("DELETE", "/api/sessions/"), false);
  });

  test("does not claim unmigrated paths", () => {
    for (const path of [
      "/", // SPA fallback
      "/api/events", // SSE — needs streaming capture (P2)
      "/api/alerts", // SSE — same
      "/anything",
    ]) {
      assert.equal(ownsRequest("GET", path), false, `${path} must stay on the legacy dispatcher`);
    }
  });
});

describe("app.js — response capture", () => {
  test("records status, headers and body instead of writing to a socket", () => {
    const capture = createResponseCapture();
    assert.equal(capture.headersSent, false);
    capture.setHeader("X-One", "1");
    capture.writeHead(201, { "Content-Type": "application/json" });
    capture.end("body");
    assert.equal(capture.headersSent, true);
    const { status, headers, body } = capture.result();
    assert.equal(status, 201);
    assert.equal(body, "body");
    // Header names are normalised to lower case, which is what the HTTP layer expects.
    assert.equal(headers.get("x-one"), "1");
    assert.equal(headers.get("content-type"), "application/json");
  });

  test("writeHead marks the response sent, which is what gates check before answering", () => {
    const capture = createResponseCapture();
    capture.writeHead(403);
    assert.equal(capture.headersSent, true);
  });
});

describe("app.js — Hono route parity with the legacy dispatcher", () => {
  const app = createHonoApp();

  test("GET /api/health returns the legacy payload byte for byte", async () => {
    const res = await app.request("/api/health", {}, { incoming: fakeIncoming() });
    assert.equal(res.status, 200);
    const expected = legacyHealth();
    assert.equal(await res.text(), expected.body);
    assert.equal(res.headers.get("content-type"), expected.headers.get("content-type"));
  });

  test("a trusted Origin gets the same CORS set as the legacy layer", async () => {
    const origin = "http://127.0.0.1:18090";
    const res = await app.request("/api/health", { headers: { origin } }, { incoming: fakeIncoming({ origin }) });
    // Gate 1 reflects the caller's own origin and always varies on it. Losing these
    // through the capture→response conversion is exactly the bug this guards.
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("vary"), "Origin");
    assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type, Authorization");
  });

  test("an untrusted Origin gets no Access-Control-Allow-Origin", async () => {
    const origin = "https://evil.example";
    const res = await app.request("/api/health", { headers: { origin } }, { incoming: fakeIncoming({ origin }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    // The response still varies by Origin, so a cache cannot serve the trusted
    // variant to an untrusted caller.
    assert.equal(res.headers.get("vary"), "Origin");
  });
});
