// webui/test/routes/engine-capabilities.check.mjs
//
// HTTP-level tests for GET /api/engine-capabilities (engine-abstraction
// batch B1): the happy path (declaration + degradation summary), the
// 404 for an unknown provider, and — the load-bearing one — the 501
// mapping: when a handler throws EngineCapabilityNotSupportedError, the
// Hono layer (app.js#invokeHandler) must answer 501 with the structured
// engine_capability_not_supported payload, never a 500 and never a
// fake-success empty body (#110 discipline).
//
// Mock strategy: engine/index.js is mocked once inside the suite's
// `before` hook (dispatch-through wrapper, same pattern as
// test/helpers/_setup.js — node:test module mocks only affect imports
// that happen after registration), then app.js and the route module are
// imported dynamically. The error class itself is NOT mocked —
// invokeHandler matches with instanceof against engine/errors.js,
// so the test must throw the real class.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { absPath } from "../helpers/_setup.js";

const { EngineCapabilityNotSupportedError } = await import(
  absPath("engine/errors.js")
);
const realEngine = await import(absPath("engine/index.js"));

// Dispatch-through: registered once, per-test behaviour flips the impl.
let getEngineProviderImpl = realEngine.getEngineProvider;

// Filled by before() after the mock is registered.
let createHonoApp, ownsRequest, OWNED_ROUTES, handleEngineCapabilities;

before(async (t) => {
  // Note the option key: this Node line uses `namedExports` (same as
  // test/helpers/_setup.js); a `named` key is silently ignored and the
  // mock namespace comes up empty.
  t.mock.module(absPath("engine/index.js"), {
    namedExports: {
      ...realEngine,
      getEngineProvider: (id) => getEngineProviderImpl(id),
    },
  });
  // Everything downstream imports AFTER the mock is registered.
  const appModule = await import(absPath("app.js"));
  createHonoApp = appModule.createHonoApp;
  ownsRequest = appModule.ownsRequest;
  OWNED_ROUTES = appModule.OWNED_ROUTES;
  const routeModule = await import(absPath("routes/engine-capabilities.js"));
  handleEngineCapabilities = routeModule.handleEngineCapabilities;
});

function fakeIncoming({ method = "GET", url = "/api/engine-capabilities" } = {}) {
  return { method, url, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

// The handler reads the query off `incoming.url`, so requests carrying
// one must pass the full URL through fakeIncoming — Hono's own c.req.url
// is not what the legacy-shaped handler sees.
const incomingWith = (url) => fakeIncoming({ url });

describe("GET /api/engine-capabilities — happy path", () => {
  test("is owned by the Hono layer and in the OWNED_ROUTES ledger", () => {
    assert.ok(ownsRequest("GET", "/api/engine-capabilities"));
    assert.ok(OWNED_ROUTES.has("GET /api/engine-capabilities"));
  });

  test("returns the default provider's 14-key declaration + summary", async () => {
    const app = createHonoApp();
    const res = await app.request("/api/engine-capabilities", {}, { incoming: fakeIncoming() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider, "local-runtime-v2");
    assert.equal(body.transport, "runtime");
    assert.equal(Object.keys(body.capabilities).length, 14);
    assert.equal(body.capabilities.turnDiff.level, "full");
    assert.equal(body.capabilities.updateCheck.level, "none");
    assert.deepEqual(body.unavailable.none, ["updateCheck"]);
  });

  test("?provider= selects the other wired surface", async () => {
    const app = createHonoApp();
    const url = "/api/engine-capabilities?provider=tui-runtime-adapter";
    const res = await app.request(url, {}, { incoming: incomingWith(url) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, "tui-runtime-adapter");
    assert.equal(body.capabilities.turnDiff.level, "none");
    assert.deepEqual(body.unavailable.none, ["turnDiff", "updateCheck"]);
  });

  test("?provider=<unknown> answers 404 with the known list, never 501", async () => {
    const app = createHonoApp();
    const url = "/api/engine-capabilities?provider=carrier-pigeon";
    const res = await app.request(url, {}, { incoming: incomingWith(url) });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "unknown_engine_provider");
    assert.ok(body.knownProviders.includes("local-runtime-v2"));
  });
});

describe("501 mapping — EngineCapabilityNotSupportedError through invokeHandler", () => {
  test("an undeclared capability surfaces as 501 + structured payload, not 500", async (t) => {
    getEngineProviderImpl = () => {
      throw new EngineCapabilityNotSupportedError({
        capability: "turnDiff",
        provider: "tui-runtime-adapter",
        reason: "implementation-absent: adapter exposes no turn-diff method",
      });
    };
    t.after(() => {
      getEngineProviderImpl = realEngine.getEngineProvider;
    });
    const app = createHonoApp();
    const res = await app.request("/api/engine-capabilities", {}, { incoming: fakeIncoming() });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "engine_capability_not_supported");
    assert.equal(body.capability, "turnDiff");
    assert.equal(body.provider, "tui-runtime-adapter");
    assert.ok(body.reason.includes("implementation-absent"));
    assert.ok(!("missing" in body), "no missing sub-items on this throw");
  });

  // invokeHandler's async-rejection branch maps the same error the same
  // way (mirroring the 413 branch). No synchronous route throws it on a
  // promise yet — the first async consumer arrives with the M3 routes,
  // which will carry a real-path test for that branch.
});

// Direct handler test (no Hono) — pins the payload shape at the unit
// level too, so a regression is attributable to one layer.
describe("handleEngineCapabilities — direct handler", () => {
  function fakeRes() {
    const res = {
      _status: null,
      _headers: null,
      _body: null,
      writeHead(s, h) {
        this._status = s;
        if (h) this._headers = h;
      },
      end(b) {
        this._body = b;
      },
    };
    return res;
  }
  const fakeReq = (url) =>
    Object.assign(Readable.from([]), { url, headers: {}, socket: { remoteAddress: "127.0.0.1" } });

  test("answers 200 with the declaration for the default provider", async () => {
    const res = fakeRes();
    await handleEngineCapabilities(fakeReq("/api/engine-capabilities"), res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.provider, "local-runtime-v2");
    assert.equal(Object.keys(body.capabilities).length, 14);
  });

  test("answers 404 for an unknown provider", async () => {
    const res = fakeRes();
    await handleEngineCapabilities(fakeReq("/api/engine-capabilities?provider=nope"), res);
    assert.equal(res._status, 404);
    assert.equal(JSON.parse(res._body).code, "unknown_engine_provider");
  });
});
