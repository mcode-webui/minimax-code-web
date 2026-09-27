// webapp/test/url-restore.test.ts
//
// Pure-logic pins for webui/lib/url-restore.ts.
//
// Two surfaces under test:
//
//   1. parseSessionFromUrl — a URL grammar helper. Pure; one assertion
//      per grammar edge-case.
//
//   2. applySessionRestore — issues a network call via api.switchSession.
//      The unit-under-test is the DECISION TREE (ok / not-found / no-op
//      / error) the page module branches on, not the wire itself.
//      We mock `globalThis.fetch` for the duration of each scenario so
//      the same `request()` codepath the production client uses runs
//      here, with a stubbed HTTP response — the same pattern as
//      webapp/test/api-permissions.test.ts.
//
// We deliberately do NOT test writeSessionToUrl here — it touches
// window.history, which is jsdom territory. The call site in
// app/page.tsx is straight-line (replaceState with the next URL), and
// the live self-check exercises its effect end-to-end.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  applySessionRestore,
  parseSessionFromUrl,
  SESSION_QUERY,
} from "../lib/url-restore";

const realFetch = globalThis.fetch;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(responder: (url: string) => Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url));
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- parseSessionFromUrl ---------------------------------------------------

describe("parseSessionFromUrl", () => {
  test("returns the session id when present", () => {
    assert.equal(
      parseSessionFromUrl("https://example.com/?session=abc-123"),
      "abc-123",
    );
  });

  test("coexists with other query parameters", () => {
    assert.equal(
      parseSessionFromUrl("https://example.com/?token=t&session=foo&extra=x"),
      "foo",
    );
  });

  test("returns null when the param is missing or blank", () => {
    for (const href of [
      "https://example.com/",
      "https://example.com/?session=",
      "https://example.com/?session=   ",
      "https://example.com/?other=x",
      "",
    ]) {
      assert.equal(parseSessionFromUrl(href), null);
    }
  });

  test("trims surrounding whitespace from the value", () => {
    assert.equal(
      parseSessionFromUrl("https://example.com/?session=%20abc%20"),
      "abc",
    );
  });

  test("preserves the constant SESSION_QUERY it reads from", () => {
    // A regression that flips the query parameter name would silently
    // break the deep-linking contract; this assertion documents the
    // value the rest of the codebase depends on.
    assert.equal(SESSION_QUERY, "session");
  });

  test("returns null for unparseable urls without throwing", () => {
    assert.equal(parseSessionFromUrl(null as unknown as string), null);
    assert.equal(parseSessionFromUrl(undefined as unknown as string), null);
  });
});

// --- applySessionRestore (decision tree, via fetch stub) -------------------

describe("applySessionRestore (decision tree)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("no-op when no session id is requested", async () => {
    let called = false;
    captureFetch(() => {
      called = true;
      return jsonResponse({ ok: true });
    });
    const out = await applySessionRestore(null, null);
    assert.equal(out.status, "no-op");
    assert.equal(out.sessionId, null);
    assert.equal(called, false);
  });

  test("skips the round-trip when the active id already matches", async () => {
    let called = false;
    captureFetch(() => {
      called = true;
      return jsonResponse({ ok: true });
    });
    const out = await applySessionRestore("mvs_same", "mvs_same");
    assert.equal(out.status, "no-op");
    assert.equal(out.sessionId, "mvs_same");
    assert.equal(called, false);
  });

  test("returns 'ok' when the server accepts the switch", async () => {
    const calls = captureFetch((url) => {
      assert.match(url, /\/api\/sessions\/switch/);
      return jsonResponse({ ok: true });
    });
    const out = await applySessionRestore("mvs_target", null);
    assert.equal(out.status, "ok");
    assert.equal(out.sessionId, "mvs_target");
    // And the body carried the id forward — pinned so a future refactor
    // that strips the body shape does not silently regress.
    const call = calls[0];
    assert.ok(call, "expected exactly one request");
    assert.equal(calls.length, 1);
    assert.equal((call.init.body as string) ?? "", JSON.stringify({ id: "mvs_target" }));
  });

  test("returns 'not-found' when the server says ok:false (with error)", async () => {
    captureFetch(() =>
      jsonResponse({ ok: false, error: "session not found" }, 200),
    );
    const out = await applySessionRestore("mvs_gone", null);
    assert.equal(out.status, "not-found");
    assert.equal(out.sessionId, "mvs_gone");
    assert.match(out.message ?? "", /not found/);
  });

  test("classifies a 404 thrown by the request helper as 'not-found'", async () => {
    captureFetch((url) =>
      new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const out = await applySessionRestore("mvs_404", null);
    assert.equal(out.status, "not-found");
    assert.match(out.message ?? "", /not found/);
  });

  test("classifies non-404 failures as 'error' so the hint copy is honest", async () => {
    captureFetch(() =>
      new Response("internal failure", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const out = await applySessionRestore("mvs_500", null);
    assert.equal(out.status, "error");
    assert.match(out.message ?? "", /HTTP 500/);
  });
});
