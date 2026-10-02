// webui/test/lib/engine/account-reads.test.js
//
// M3-B4: the account read's engine facade (#20).
//
// What this file pins, and why the family needs pinning at all when
// the endpoint is five lines long:
//
//   1. THE DECLARATION. #20 and B3's #15 / #16 read the SAME engine
//      projection through the SAME `mcode/account/status` method, so
//      they must be gated by the SAME `authCredentials.getAccountStatus`
//      pair. If the two ever drift, a provider that drops the method
//      takes one endpoint down and leaves the other claiming a quota it
//      cannot read — section 1 asserts the pair against the usage
//      family's own table, not against a copy of it.
//
//   2. THE SOFT-FAILURE BODY. `{ok:false, reason}` at HTTP 200 is the
//      account card's documented empty state, and it is produced by the
//      ENGINE failing, not by the request failing. A refactor that
//      converts it into a thrown error or a 500 turns a card that
//      renders 本地用户 into a broken menu.
//
//   3. THE SUCCESS BODY'S SPREAD. `{ok:true, ...r.data}` means the
//      engine frames its own projection; a layer that started picking
//      fields (`payload.identity`, `payload.tokenPlan`) would silently
//      drop every field the engine adds next year, and no test that
//      only checks today's fields would notice.
//
//   4. THE GATE IS REAL, AND THE MOCK IS REAL. The registered provider
//      declares `authCredentials` `full`, so only this file can prove
//      the gate would bite. And node:test's `mock.module` re-evaluates
//      only the MOCKED specifier, so a route module already in the
//      registry keeps its old live binding — every route test here
//      re-imports the route under a fresh `?bust=N`, and section 5 ends
//      with the control that proves the mock took: with no mock at all,
//      the same request answers from the real rpc layer.
//
// Test style follows test/lib/engine/usage-reads.test.js (B3) and
// test/lib/engine/session-tree-reads.test.js (B2): table-driven, one row
// per case.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { setupMocks, absPath, registerRpcMock } from "../../helpers/_setup.js";

const { ENGINE_CAPABILITY_KEYS } = await import("../../../server/engine/index.js");
const {
  ACCOUNT_READ_ENDPOINTS,
  assertAccountReadCapability,
  readEngineAccount,
  resolveAccountReadProvider,
} = await import("../../../server/engine/account-reads.js");
const { EngineCapabilityNotSupportedError, isEngineCapabilityNotSupportedError } = await import(
  "../../../server/engine/errors.js"
);
const { USAGE_READ_ENDPOINTS } = await import("../../../server/engine/usage-reads.js");

const RUNTIME = "runtime";
const ACP = "acp";

after(() => {
  registerRpcMock({ getAccountStatus: async () => ({ ok: false, code: "no_client" }) });
});

// ---------------------------------------------------------------------------
// 1. The endpoint → capability declaration table
// ---------------------------------------------------------------------------

describe("ACCOUNT_READ_ENDPOINTS — this batch's declaration table", () => {
  test("covers exactly the one endpoint of the account family", () => {
    assert.deepEqual(Object.keys(ACCOUNT_READ_ENDPOINTS), ["GET /api/account"]);
  });

  test("GET /api/account declares authCredentials.getAccountStatus", () => {
    // Table-driven: editing this row is a capability decision and must be
    // reviewed as one, so the table IS the assertion.
    const row = { capability: "authCredentials", subItem: "getAccountStatus" };
    assert.deepEqual(ACCOUNT_READ_ENDPOINTS["GET /api/account"], row);
    assert.ok(ENGINE_CAPABILITY_KEYS.includes(row.capability));
  });

  test("it is the SAME pair B3's usage endpoints declare, because it is the same engine call", () => {
    // The whole point of section 1. #20, #15 and #16 all read the
    // engine's account projection through `mcode/account/status`; a
    // `partial` provider that drops `getAccountStatus` must be refused
    // by all three, in the same way, naming the same method.
    for (const endpoint of ["POST /api/usage", "POST /api/usage-trigger"]) {
      assert.deepEqual(
        ACCOUNT_READ_ENDPOINTS["GET /api/account"],
        USAGE_READ_ENDPOINTS[endpoint],
        `${endpoint} drifted from the account family`,
      );
    }
  });

  test("an endpoint outside this family is caller confusion, not an engine limitation", () => {
    assert.throws(
      () => assertAccountReadCapability("GET /api/nope", RUNTIME),
      (err) => {
        assert.ok(!(err instanceof EngineCapabilityNotSupportedError));
        assert.equal(err.code, "unknown_account_read_endpoint");
        assert.match(err.message, /not part of the account family/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Provider resolution + the gate
// ---------------------------------------------------------------------------

describe("resolveAccountReadProvider / assertAccountReadCapability", () => {
  // Table-driven. Absent means "no provider claims this transport yet"
  // (M4), which is NOT the same answer as "capability unavailable" —
  // the default `acp` transport must keep answering, so it must NOT
  // throw.
  const TRANSPORTS = [
    [RUNTIME, true, "checked", "local-runtime-v2"],
    [ACP, false, "unregistered-transport", null],
    ["exec", false, "unregistered-transport", null],
    ["", false, "unregistered-transport", null],
  ];
  for (const [transport, hasProvider, gate, providerId] of TRANSPORTS) {
    test(`transport=${JSON.stringify(transport)} → ${gate}`, () => {
      const provider = resolveAccountReadProvider(transport);
      assert.equal(!!provider, hasProvider);
      const g = assertAccountReadCapability("GET /api/account", transport);
      assert.equal(g.gate, gate);
      assert.equal(g.provider, providerId);
      assert.equal(g.capability, "authCredentials");
      assert.equal(g.subItem, "getAccountStatus");
      assert.equal(g.endpoint, "GET /api/account");
    });
  }

  test("the descriptor has exactly the six fields every family's descriptor has", () => {
    // A consumer that reads `gate.provider` under `acp` must get `null`,
    // not `undefined` — the key must EXIST. Same key set as B1/B2/B3.
    assert.deepEqual(Object.keys(assertAccountReadCapability("GET /api/account", RUNTIME)), [
      "endpoint",
      "gate",
      "provider",
      "capability",
      "subItem",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The payload — the soft-failure body and the verbatim spread
// ---------------------------------------------------------------------------

describe("readEngineAccount — the payload is the endpoint's, in both shapes", () => {
  // Every case in this table is a REAL engine answer shape the endpoint
  // has to render. The row is [engine result, expected payload, why].
  const TABLE = [
    [
      { ok: true, data: { identity: { name: "Ada" }, tokenPlan: { tier: "pro" } } },
      { ok: true, identity: { name: "Ada" }, tokenPlan: { tier: "pro" } },
      "the projection is spread verbatim",
    ],
    [
      { ok: true, data: { identity: { name: "Ada" }, futureEngineField: 7 } },
      { ok: true, identity: { name: "Ada" }, futureEngineField: 7 },
      "a field webui has never heard of still reaches the card",
    ],
    [
      { ok: true, data: null },
      { ok: true },
      "`data:null` must not throw on the spread",
    ],
    [
      { ok: true, data: undefined },
      { ok: true },
      "an absent `data` behaves the same as a null one",
    ],
    [
      { ok: true },
      { ok: true },
      "no `data` key at all",
    ],
    [
      { ok: false, code: "no_client" },
      { ok: false, reason: "no_client" },
      "the engine's own machine-readable code becomes the reason",
    ],
    [
      { ok: false, code: "unauthorized" },
      { ok: false, reason: "unauthorized" },
      "any code, verbatim",
    ],
    [
      { ok: false, error: "boom" },
      { ok: false, reason: "account_unavailable" },
      "no code → the endpoint's own historical fallback string",
    ],
    [
      { ok: false, code: "" },
      { ok: false, reason: "account_unavailable" },
      "an empty code is falsy and falls back, exactly as `||` did",
    ],
    [
      null,
      { ok: false, reason: "account_unavailable" },
      "a null result must not throw — it is a failure, not a crash",
    ],
  ];
  for (const [result, expected, why] of TABLE) {
    test(`${why}: ${JSON.stringify(result)} → ${JSON.stringify(expected)}`, async (t) => {
      await setupMocks(t, { acp: {} });
      // `setupMocks` already registered the `lib/mcode-rpc.js` mock and
      // node:test refuses a second registration for the same specifier
      // (ERR_INVALID_STATE), so the payload is injected through the
      // helper's mutable dispatch-through holder — the mechanism
      // `registerRpcMock` exists for.
      registerRpcMock({ getAccountStatus: async () => result });
      const read = await readEngineAccount({ cs: { mcodeSessionId: "mvs_1" }, transport: RUNTIME });
      assert.deepEqual(read.payload, expected);
      assert.equal(read.source, "account-status");
      assert.equal(read.gate.gate, "checked");
    });
  }

  test("the failure payload has EXACTLY two keys, in order", async (t) => {
    // A key-set assertion, not a subset: a facade that helpfully added
    // `provider` or `gate` to the failure body would be a frontend
    // contract change, and `ok:false` bodies are what the card branches
    // on.
    await setupMocks(t, { acp: {} });
    registerRpcMock({ getAccountStatus: async () => ({ ok: false, code: "no_client" }) });
    const read = await readEngineAccount({ cs: {}, transport: RUNTIME });
    assert.deepEqual(Object.keys(read.payload), ["ok", "reason"]);
  });

  test("cs.mcodeSessionId is forwarded EXACTLY as the route computed it", async (t) => {
    // Table-driven: [ctx-ish cs, expected forwarded argument]. The route
    // used to evaluate `ctx && ctx.cs && ctx.cs.mcodeSessionId`, so a
    // missing ctx forwarded `undefined` and a cs without a session id
    // forwarded `undefined` too — but a cs whose id is `""` forwarded
    // `""`. `getAccountStatus` turns any falsy value into `{}`, so the
    // difference is invisible on the wire and very visible to a test
    // that pins the call.
    await setupMocks(t, { acp: {} });
    const seen = [];
    registerRpcMock({
      getAccountStatus: async (sessionId) => {
        seen.push(sessionId);
        return { ok: true, data: {} };
      },
    });
    const CASES = [
      [{ mcodeSessionId: "mvs_1" }, "mvs_1"],
      [{ mcodeSessionId: "" }, ""],
      [{}, undefined],
      [{ mcodeSessionId: null }, null],
      [{ mcodeSessionId: 0 }, 0],
    ];
    for (const [cs] of CASES) {
      await readEngineAccount({ cs, transport: RUNTIME });
    }
    // A missing ctx entirely: the facade must not throw on `undefined`.
    await readEngineAccount({ transport: RUNTIME });
    seen.push("<end>");
    assert.deepEqual(seen, ["mvs_1", "", undefined, null, 0, undefined, "<end>"]);
  });

  test("the gate runs BEFORE the engine call", async (t) => {
    // Order matters: a provider that does not offer `getAccountStatus`
    // must cost zero engine calls, so the 501 does not depend on the
    // engine answering anything at all.
    await setupMocks(t, { acp: {} });
    let called = 0;
    registerRpcMock({
      getAccountStatus: async () => {
        called += 1;
        return { ok: true, data: {} };
      },
    });
    await assert.rejects(
      () => readEngineAccount({ cs: {}, endpoint: "GET /api/nope", transport: RUNTIME }),
      (err) => {
        assert.ok(!isEngineCapabilityNotSupportedError(err));
        assert.equal(err.code, "unknown_account_read_endpoint");
        return true;
      },
    );
    assert.equal(called, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. The route
// ---------------------------------------------------------------------------

describe("handleGetAccount — the route asks the facade", () => {
  // One fresh route module per test: node:test's `mock.module`
  // re-evaluates only the MOCKED specifier, but a route module already
  // in the registry keeps its old LIVE BINDING to the facade — without
  // the `?bust=N` re-import the second test here would silently
  // exercise the first test's mock and pass for the wrong reason.
  let bust = 0;
  const loadRoute = async () => import(`${absPath("routes/account.js")}?bust=${bust++}`);

  // `mock.module` REPLACES the whole namespace, so a partial mock makes
  // the route fail to instantiate on the exports it did not stub
  // ("does not provide an export named …"). `readEngineAccount` is the
  // route's only facade import, but the helper is kept so the next
  // family to copy this file has the shape ready.
  const NOT_STUBBED = (name) => async () => {
    throw new Error(`B4 test called ${name}, which this case did not stub`);
  };
  function mockFacade(t, overrides) {
    t.mock.module(absPath("engine/account-reads.js"), {
      namedExports: { readEngineAccount: NOT_STUBBED("readEngineAccount"), ...overrides },
    });
  }

  function mkRes() {
    const written = [];
    return {
      written,
      writeHead(status, headers) {
        written.push({ status, headers });
        return this;
      },
      end(body) {
        written.push({ body });
        return this;
      },
    };
  }

  test("both bodies are written byte-for-byte at HTTP 200", async (t) => {
    // Two cases, one mock registration: node:test refuses to mock the
    // same specifier twice inside one test, and a mutable holder is the
    // honest way to say "the same route, two payloads".
    const CASES = [
      { ok: true, identity: { name: "Ada" }, tokenPlan: { tier: "pro" } },
      { ok: false, reason: "no_client" },
    ];
    let current = CASES[0];
    mockFacade(t, {
      readEngineAccount: async () => ({
        payload: current,
        source: "account-status",
        gate: {},
        transport: RUNTIME,
      }),
    });
    for (const payload of CASES) {
      current = payload;
      const route = await loadRoute();
      const res = mkRes();
      await route.handleGetAccount(null, res, { cs: { mcodeSessionId: "mvs_1" } });
      assert.equal(res.written[0].status, 200);
      assert.equal(res.written[0].headers["Content-Type"], "application/json; charset=utf-8");
      assert.equal(res.written[1].body, JSON.stringify(payload));
    }
  });

  test("the route hands its ctx straight through and does not read cs itself", async (t) => {
    await setupMocks(t, { acp: {} });
    const seen = [];
    mockFacade(t, {
      readEngineAccount: async (o) => {
        seen.push(o);
        return { payload: { ok: true }, source: "account-status", gate: {}, transport: RUNTIME };
      },
    });
    const route = await loadRoute();
    // A missing ctx is a real call shape (`invokeHandler` always sets
    // one, but the route's signature must not assume it) and must not
    // throw — `ctx && ctx.cs` is what the pre-facade route evaluated.
    for (const ctx of [{ cs: { mcodeSessionId: "mvs_1" } }, { cs: null }, undefined, {}]) {
      await route.handleGetAccount(null, mkRes(), ctx);
    }
    assert.equal(seen.length, 4);
    assert.deepEqual(seen[0].cs, { mcodeSessionId: "mvs_1" });
    assert.equal(seen[1].cs, null);
    assert.equal(seen[2].cs, undefined);
    assert.equal(seen[3].cs, undefined);
    // The route must not pass an endpoint key of its own: the facade's
    // default IS the endpoint, and a route that spelled it out would be
    // a second place to get it wrong.
    for (const o of seen) assert.equal(o.endpoint, undefined);
  });

  test("a capability error PROPAGATES so invokeHandler can answer 501", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, {
      readEngineAccount: async () => {
        throw new EngineCapabilityNotSupportedError({
          capability: "authCredentials",
          provider: "fixture-provider",
          missing: ["getAccountStatus"],
          reason: "test fixture",
        });
      },
    });
    const route = await loadRoute();
    await assert.rejects(
      () => route.handleGetAccount(null, mkRes(), { cs: {} }),
      isEngineCapabilityNotSupportedError,
    );
  });

  // ---- proof the mock actually took ------------------------------------

  test("PROOF the facade mock took: a marker error escapes the untouched route", async (t) => {
    // Without a fresh `?bust=` re-import, `mock.module` would leave the
    // route holding the PREVIOUS test's live binding, the marker would
    // never be thrown, and this assertion would fail — which is the
    // point: it is the only assertion here that cannot pass by accident.
    await setupMocks(t, { acp: {} });
    const marker = new Error("B4-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
      readEngineAccount: async () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleGetAccount(null, mkRes(), { cs: {} });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the facade error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("CONTROL: with no facade mock, the same request reaches the rpc layer", async (t) => {
    // The other half of the proof. A `?bust=` re-import under a fresh
    // test hook gives a route bound to the REAL facade, so the request
    // answers from the rpc layer. The holder is process-global and the
    // previous cases left payloads in it, so this one puts back the
    // clean-disk default — `no_client`, the answer the account card
    // renders its empty state from in production when no engine has
    // attached.
    await setupMocks(t, { acp: {} });
    registerRpcMock({ getAccountStatus: async () => ({ ok: false, code: "no_client" }) });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleGetAccount(null, res, { cs: { mcodeSessionId: "mvs_1" } });
    assert.equal(res.written[0].status, 200);
    assert.deepEqual(JSON.parse(res.written[1].body), { ok: false, reason: "no_client" });
  });
});
