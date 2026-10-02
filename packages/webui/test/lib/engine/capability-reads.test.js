// webui/test/lib/engine/capability-reads.test.js
//
// M3-B4: the capability-declaration read's engine facade (#73).
//
// This is the one endpoint in the migration that CHANGES its response,
// so the tests here are mostly about pinning exactly how much changed
// and why the rest did not:
//
//   1. THE ADDITIVE CHANGE. #73 gains one key, `engine`, carrying the
//      engine-capabilities view. Every key that existed before keeps
//      its exact name, position and value — the ACP wire table stays
//      under `capabilities`, the `initialize` mirror stays under
//      `mcodeVersion` / `mcodeName` / `mcodeTitle`, and `notes` stays
//      last. Section 4 asserts the full key order of the response, so a
//      future "let me just replace the wire table with the 14 keys"
//      cannot land without a reviewer seeing the test fail.
//
//   2. `providerFor`. The view must say whether the declaration came
//      from the ACTIVE transport's provider or from the default
//      provider standing in for a transport nothing claims yet (M4).
//      A capability-detection endpoint that reported a standing-in
//      declaration as though it were the connected engine's is the
//      same lie B1 declined for `/api/health` — and this is the one
//      endpoint where it is most tempting, because the fallback is
//      silent and always succeeds.
//
//   3. THE EMPTY-DECLARATION RULE. #73 must never answer an empty
//      view. A frontend that gets `{capabilities:{}}` cannot tell "no
//      engine" from "this build has no declarations", and the whole
//      point of the endpoint is that distinction.
//
//   4. THE GATE IS A NO-OP, AND SAYS SO. #73 is the declaration
//      endpoint; gating the gate would let a `none` hide the
//      declaration that says so. `checkCapabilityReadCapability` must
//      report `no-capability-key` under EVERY transport, including a
//      provider that declares nothing at all.
//
// Test style follows test/lib/engine/usage-reads.test.js (B3) and
// test/lib/engine/account-reads.test.js (B4 #20).

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { setupMocks, absPath, registerAcpMock, registerRpcMock } from "../../helpers/_setup.js";

const {
  CAPABILITY_READ_ENDPOINTS,
  checkCapabilityReadCapability,
  readEngineCapabilityView,
  resolveCapabilityReadProvider,
} = await import("../../../server/engine/capability-reads.js");
const { ENGINE_CAPABILITY_KEYS, LOCAL_RUNTIME_V2_CAPABILITIES } = await import(
  "../../../server/engine/index.js"
);
const { summarizeUnavailableCapabilities } = await import("../../../server/engine/capabilities.js");

const RUNTIME = "runtime";
const ACP = "acp";

const AGENT_INFO = { name: "mcode", title: "Mcode", version: "0.5.5" };
const WIRE = { set_mode: true, set_config_option: true, cancel: true, activate: true };

after(() => {
  registerAcpMock({ getMcodeServerInfo: () => null });
  registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
});

// ---------------------------------------------------------------------------
// 1. The declaration table — the no-op, pinned
// ---------------------------------------------------------------------------

describe("CAPABILITY_READ_ENDPOINTS — the gate is a reported no-op", () => {
  test("covers exactly the one endpoint of the capability family", () => {
    assert.deepEqual(Object.keys(CAPABILITY_READ_ENDPOINTS), [
      "GET /api/protocol/capabilities",
    ]);
  });

  test("#73 declares NO capability — it IS the declaration endpoint", () => {
    // Gating the gate is circular: a `none` anywhere in the declaration
    // could hide the declaration that says so. The value is `null` for
    // the same reason B1's `/api/health` and B3's `/api/usage/forecast`
    // are.
    assert.equal(CAPABILITY_READ_ENDPOINTS["GET /api/protocol/capabilities"], null);
  });

  // Table-driven over EVERY transport, not just the two that matter: the
  // assertion is that the no-op is unconditional.
  const TRANSPORTS = [RUNTIME, ACP, "exec", "", "nonsense"];
  for (const transport of TRANSPORTS) {
    test(`transport=${JSON.stringify(transport)} → no-capability-key`, () => {
      const g = checkCapabilityReadCapability("GET /api/protocol/capabilities", transport);
      assert.equal(g.gate, "no-capability-key");
      assert.equal(g.capability, null);
      assert.equal(g.subItem, null);
      assert.equal(g.enforcement, "soft");
      // The provider is still NAMED even though nothing is checked —
      // "no capability key" must not degrade into "no provider".
      assert.equal(g.provider, "local-runtime-v2");
    });
  }

  test("an endpoint outside this family is caller confusion", () => {
    assert.throws(
      () => checkCapabilityReadCapability("GET /api/nope", RUNTIME),
      (err) => {
        assert.equal(err.code, "unknown_capability_read_endpoint");
        assert.match(err.message, /not part of the capability family/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Provider resolution — always answers, and says how
// ---------------------------------------------------------------------------

describe("resolveCapabilityReadProvider — it never returns nothing", () => {
  // Table-driven. `[transport, providerFor]` — the whole family differs
  // from B1/B2/B3 here: there is no `null` row, because an empty
  // capability view is worse than useless for a capability-DETECTION
  // endpoint. The `providerFor` field is what keeps the fallback honest.
  const TRANSPORTS = [
    [RUNTIME, "transport"],
    [ACP, "default"],
    ["exec", "default"],
    ["", "default"],
    ["nonsense", "default"],
  ];
  for (const [transport, providerFor] of TRANSPORTS) {
    test(`transport=${JSON.stringify(transport)} → providerFor=${providerFor}`, () => {
      const { provider, providerFor: actual } = resolveCapabilityReadProvider(transport);
      assert.equal(provider.id, "local-runtime-v2");
      assert.equal(provider.transport, "runtime");
      assert.equal(actual, providerFor);
      // The declaration served is the real reviewed object, not a copy
      // that could drift from it.
      assert.equal(provider.capabilities, LOCAL_RUNTIME_V2_CAPABILITIES);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The view
// ---------------------------------------------------------------------------

describe("readEngineCapabilityView", () => {
  test("the view is the engine-capabilities payload /api/engine-capabilities serves", async (t) => {
    // Same four facts, same source objects. If the two endpoints ever
    // answer different declarations there are two truths in webui, and
    // this assertion is what stops that.
    await setupMocks(t, { acp: { getMcodeServerInfo: () => AGENT_INFO } });
    registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
    const read = await readEngineCapabilityView({ transport: RUNTIME });
    assert.deepEqual(Object.keys(read.engine), [
      "provider",
      "providerFor",
      "transport",
      "capabilities",
      "unavailable",
    ]);
    assert.deepEqual(Object.keys(read.engine.capabilities), [...ENGINE_CAPABILITY_KEYS]);
    assert.equal(read.engine.capabilities, LOCAL_RUNTIME_V2_CAPABILITIES);
    assert.deepEqual(
      read.engine.unavailable,
      summarizeUnavailableCapabilities(LOCAL_RUNTIME_V2_CAPABILITIES),
    );
    assert.equal(read.source, "declaration");
    assert.equal(read.transport, RUNTIME);
  });

  // Table-driven. The `initialize` mirror is empty until something
  // attaches, and the endpoint's own fallbacks must survive that — #75
  // answers the same figure with the same fallback, and two endpoints
  // answering it differently would be the defect.
  const AGENT_CASES = [
    [{ name: "mcode", title: "Mcode", version: "0.5.5" }, { version: "0.5.5", name: "mcode", title: "Mcode" }],
    [{ version: "0.5.5" }, { version: "0.5.5", name: null, title: null }],
    [{ name: "mcode" }, { version: "unknown", name: "mcode", title: null }],
    [null, { version: "unknown", name: null, title: null }],
  ];
  for (const [info, expected] of AGENT_CASES) {
    test(`agentInfo ${JSON.stringify(info)} → ${JSON.stringify(expected)}`, async (t) => {
      await setupMocks(t, { acp: { getMcodeServerInfo: () => info } });
      registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
      const read = await readEngineCapabilityView({ transport: RUNTIME });
      assert.deepEqual(read.agent, expected);
      assert.deepEqual(Object.keys(read.agent), ["version", "name", "title"]);
    });
  }

  // Table-driven. The VIEW's `providerFor` — not just the resolver's —
  // is what a consumer branches on, so a facade that resolved the
  // provider honestly and then hard-coded the label in the payload would
  // defeat the whole point. This table is the assertion that separates
  // those two.
  const PROVIDER_FOR = [
    [RUNTIME, "transport"],
    [ACP, "default"],
    ["exec", "default"],
    ["nonsense", "default"],
  ];
  for (const [transport, expected] of PROVIDER_FOR) {
    test(`the view reports providerFor=${expected} on transport ${JSON.stringify(transport)}`, async (t) => {
      await setupMocks(t, { acp: {} });
      registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
      const read = await readEngineCapabilityView({ transport });
      assert.equal(read.engine.providerFor, expected);
      // And the two halves cannot disagree: `providerFor: "transport"`
      // with a provider the transport does not own is the lie.
      assert.equal(read.engine.providerFor === "transport", transport === RUNTIME);
    });
  }

  test("an empty transport override means 'the ambient one', and the view says so", async (t) => {
    // `options.transport || config.MCODE_WEBUI_TRANSPORT` treats `""` as
    // "not specified" — the same idiom every other read family uses. It
    // is also why the table above has no `""` row: the answer would
    // depend on the gate's own `MCODE_WEBUI_TRANSPORT`, and a test whose
    // expected value depends on the ambient env is a test that is green
    // on one transport and red on the other.
    await setupMocks(t, { acp: {} });
    registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
    const { MCODE_WEBUI_TRANSPORT } = await import(absPath("lib/config.js"));
    const read = await readEngineCapabilityView({ transport: "" });
    assert.equal(read.transport, MCODE_WEBUI_TRANSPORT);
    assert.equal(
      read.engine.providerFor,
      MCODE_WEBUI_TRANSPORT === RUNTIME ? "transport" : "default",
    );
  });

  test("the ACP wire table is forwarded by REFERENCE, not copied", async (t) => {
    // A copy would be a second answer to "which ACP methods exist",
    // freezable in a way the source is not. Identity pins the
    // forwarding.
    await setupMocks(t, { acp: {} });
    registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
    const read = await readEngineCapabilityView({ transport: RUNTIME });
    assert.equal(read.wire, WIRE);
  });

  test("the gate is evaluated and reported, and never blocks the read", async (t) => {
    await setupMocks(t, { acp: {} });
    registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
    // Every transport, including one no provider claims. A read that
    // gated would throw here; a read that skipped the check entirely
    // would have no `gate` field at all.
    for (const transport of [RUNTIME, ACP, "exec"]) {
      const read = await readEngineCapabilityView({ transport });
      assert.equal(read.gate.gate, "no-capability-key");
      assert.equal(read.gate.endpoint, "GET /api/protocol/capabilities");
    }
  });

  test("an unknown endpoint key is a plain Error, not 501 material", async (t) => {
    await setupMocks(t, { acp: {} });
    registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
    await assert.rejects(
      () => readEngineCapabilityView({ endpoint: "GET /api/nope", transport: RUNTIME }),
      (err) => {
        assert.equal(err.code, "unknown_capability_read_endpoint");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The route — the additive change, pinned key by key
// ---------------------------------------------------------------------------

describe("handleCapabilities — one key added, nothing else touched", () => {
  let bust = 0;
  const loadRoute = async () => import(`${absPath("routes/protocol.js")}?bust=${bust++}`);

  // `mock.module` REPLACES the whole namespace; the route binds one
  // facade import from this family, but the module it mocks is imported
  // by six other handlers in the same file, so the mock must answer for
  // everything the route module evaluates at load time.
  const NOT_STUBBED = (name) => async () => {
    throw new Error(`B4 test called ${name}, which this case did not stub`);
  };
  function mockFacade(t, overrides) {
    t.mock.module(absPath("engine/capability-reads.js"), {
      namedExports: { readEngineCapabilityView: NOT_STUBBED("readEngineCapabilityView"), ...overrides },
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

  const VIEW = {
    engine: {
      provider: "local-runtime-v2",
      providerFor: "transport",
      transport: "runtime",
      capabilities: { sessionCrud: { level: "full" } },
      unavailable: { none: [], partial: [] },
    },
    agent: { version: "0.5.5", name: "mcode", title: "Mcode" },
    wire: WIRE,
  };

  test("the response key order is the endpoint's, with `engine` inserted once", async (t) => {
    // This is the assertion that makes "we only added a key" a fact
    // rather than a claim. The order is the endpoint's, `engine` sits
    // directly after the wire table it complements, and `notes` stays
    // last.
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => ({ ...VIEW, source: "declaration", gate: {}, transport: RUNTIME }) });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    assert.equal(res.written[0].status, 200);
    const body = JSON.parse(res.written[1].body);
    assert.deepEqual(Object.keys(body), [
      "ok",
      "mcodeVersion",
      "mcodeName",
      "mcodeTitle",
      "capabilities",
      "engine",
      "notes",
    ]);
  });

  test("every pre-existing key keeps its exact value", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => ({ ...VIEW, source: "declaration", gate: {}, transport: RUNTIME }) });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    assert.equal(body.ok, true);
    // The ACP wire table is still the ACP wire table — the 14 matrix
    // keys did NOT replace it.
    assert.deepEqual(body.capabilities, WIRE);
    assert.equal(body.mcodeVersion, "0.5.5");
    assert.equal(body.mcodeName, "mcode");
    assert.equal(body.mcodeTitle, "Mcode");
    // `notes` is route-owned prose about webui's own routes; the facade
    // never restates it, so it is still exactly these five strings.
    assert.deepEqual(Object.keys(body.notes), ["set_mode", "set_config_option", "cancel", "activate", "fork"]);
  });

  test("the whole view is carried, and the route adds nothing to it", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => ({ ...VIEW, source: "declaration", gate: {}, transport: RUNTIME }) });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    // Identity, not equality: a route that re-projected the view would
    // be a second place for the 14 keys to be reshaped.
    assert.deepEqual(body.engine, VIEW.engine);
    // And the facade's own bookkeeping (`source`, `gate`, `transport`)
    // stays INSIDE the facade — it is diagnostic vocabulary, not part
    // of this endpoint's contract.
    for (const key of ["source", "gate"]) {
      assert.equal(key in body, false, `${key} leaked into the response`);
    }
  });

  // Table-driven: [agent version, expected mcodeVersion]. The route is a
  // PASS-THROUGH — including for the empty string, which the facade has
  // already turned into `"unknown"` (section 3 pins that), so a route
  // that applied its own `|| "unknown"` would double-apply it and a
  // route that dropped the fallback entirely would ship an empty
  // version. This table is the split made visible: the fallback lives
  // in the engine layer, once.
  const VERSION_CASES = [
    ["0.5.5", "0.5.5"],
    ["unknown", "unknown"],
    ["", ""],
  ];
  for (const [version, expected] of VERSION_CASES) {
    test(`agent.version=${JSON.stringify(version)} → mcodeVersion=${JSON.stringify(expected)}`, async (t) => {
      await setupMocks(t, { acp: {} });
      mockFacade(t, {
        readEngineCapabilityView: async () => ({
          ...VIEW,
          agent: { version, name: null, title: null },
          source: "declaration",
          gate: {},
          transport: RUNTIME,
        }),
      });
      const route = await loadRoute();
      const res = mkRes();
      await route.handleCapabilities(null, res);
      const body = JSON.parse(res.written[1].body);
      assert.equal(body.mcodeVersion, expected);
      assert.equal(body.mcodeName, null);
      assert.equal(body.mcodeTitle, null);
    });
  }

  test("a facade error PROPAGATES so invokeHandler can answer 501", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, {
      readEngineCapabilityView: async () => {
        const err = new Error("fixture capability refusal");
        err.name = "EngineCapabilityNotSupportedError";
        throw err;
      },
    });
    const route = await loadRoute();
    await assert.rejects(() => route.handleCapabilities(null, mkRes()), /fixture capability refusal/);
  });

  // ---- proof the mock actually took ------------------------------------

  test("PROOF the facade mock took: a marker error escapes the untouched route", async (t) => {
    await setupMocks(t, { acp: {} });
    const marker = new Error("B4-CAPABILITY-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
      readEngineCapabilityView: async () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleCapabilities(null, mkRes());
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the facade error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("CONTROL: with no facade mock, the real view reaches the response", async (t) => {
    // The other half of the proof: a fresh `?bust=` re-import binds the
    // route to the REAL facade, so the body carries the actual
    // registered declaration rather than the fixture's.
    await setupMocks(t, { acp: { getMcodeServerInfo: () => AGENT_INFO } });
    registerRpcMock({ MCODE_ACP_CAPABILITIES: WIRE });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    assert.equal(body.engine.provider, "local-runtime-v2");
    // The real view must SAY whether it is standing in. Under the
    // default `acp` transport that is `"default"`; reporting
    // `"transport"` there would be the one lie this endpoint cannot
    // afford, because the declaration it would attribute to a connected
    // engine came from a provider that transport never chose. The
    // expectation follows the ambient transport so the control holds on
    // both gate legs.
    const { MCODE_WEBUI_TRANSPORT } = await import(absPath("lib/config.js"));
    assert.equal(
      body.engine.providerFor,
      MCODE_WEBUI_TRANSPORT === "runtime" ? "transport" : "default",
    );
    assert.equal(body.engine.transport, "runtime");
    // `setupMocks`'s acp holder is process-global and an earlier case
    // left the agent mirror in it, so the version here is the real
    // `initialize` mirror's, not the fixture's.
    assert.equal(body.mcodeVersion, "0.5.5");
    assert.deepEqual(Object.keys(body.engine.capabilities), [...ENGINE_CAPABILITY_KEYS]);
    assert.equal(body.engine.unavailable.none.length >= 1, true);
  });
});
