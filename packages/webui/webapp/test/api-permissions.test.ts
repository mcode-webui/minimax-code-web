// webapp/test/api-permissions.test.ts
// Contract test for the permission-mode request body.
//
// Why this exists: `setPermissions` sent `{ permissions }` while
// `handleSetPermissions` reads `payload.mode`. The route does not reject an
// unrecognised key — it falls through to its `full` default — so every mode the
// user picked, "Ask" included, was applied as `bypassPermissions`. The route's
// own unit tests could not catch it: they build their bodies from the route's
// documented contract (`{ mode }`), so they agreed with the route and not with
// the client. This asserts the client's side of that contract, which is the side
// that was wrong.
//
// It calls the real client against a stubbed `fetch`, rather than mirroring the
// body shape in the test: a mirror would have agreed with the bug too.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setPermissions } from "../lib/api";

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  init: RequestInit;
}

/** Capture the one request the client makes and answer it plausibly. */
function captureFetch(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

/** The single captured call, asserted to exist so the body can be read safely. */
function only(calls: Call[]): Call {
  const call = calls[0];
  assert.ok(call, "expected exactly one request");
  assert.equal(calls.length, 1);
  return call;
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("setPermissions — request body matches the route's contract", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts the mode under `mode`, the key handleSetPermissions reads", async () => {
    const calls = captureFetch();
    await setPermissions("ask");

    const call = only(calls);
    assert.match(call.url, /\/api\/permissions/);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(bodyOf(call), { mode: "ask" });
  });

  test("does not post the `permissions` key the route ignores", async () => {
    const calls = captureFetch();
    await setPermissions("ask");

    // `permissions` is the *response* field name; sending it made the route's
    // `payload.mode` undefined and its `full` default apply instead.
    assert.equal(bodyOf(only(calls)).permissions, undefined);
  });

  test("passes the mode through unchanged for every preset", async () => {
    for (const mode of ["ask", "auto", "full"]) {
      const calls = captureFetch();
      await setPermissions(mode);
      assert.deepEqual(bodyOf(only(calls)), { mode });
    }
  });
});
