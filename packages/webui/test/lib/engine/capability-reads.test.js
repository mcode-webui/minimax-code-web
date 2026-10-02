// webui/test/lib/engine/capability-reads.test.js
//
// M3-B4: the capability-declaration read's engine facade (#73).
//
// This is the one endpoint in the migration whose RESPONSE CONTRACT
// changes, by explicit decision: `capabilities` used to be
// `MCODE_ACP_CAPABILITIES`, a hand-maintained flat `{method: boolean}`
// table of the ACP JSON-RPC surface, and it is now the engine's
// DECLARED 14-key capability object. So the tests here pin the
// replacement, not an absence of change:
//
//   1. THE REPLACEMENT. `capabilities` carries the declaration, forwarded
//      by identity, and the twelve old accessors are asserted GONE — a
//      consumer that still reads `capabilities.set_mode` must get
//      `undefined` and fail loudly rather than silently receive a
//      truthy object field. The declaration must appear exactly once in
//      the serialised body: the `engine` key an earlier shape of this
//      batch shipped was removed precisely because it carried the same
//      14 keys a second time. `mcodeVersion` / `mcodeName` /
//      `mcodeTitle` and `notes` are untouched, and `notes` stays last.
//
//   2. `capabilitiesProviderFor`. The response must say whether the
//      declaration came from the ACTIVE transport's provider or from the
//      default provider standing in for a transport nothing claims yet
//      (M4). A capability-detection endpoint that reported a
//      standing-in declaration as though it were the connected engine's
//      is the same lie B1 declined for `/api/health` — and this is the
//      one endpoint where it is most tempting, because the fallback is
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

import { setupMocks, absPath, registerAcpMock } from "../../helpers/_setup.js";

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

after(() => {
  registerAcpMock({ getMcodeServerInfo: () => null });
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
  test("the read is the engine-capabilities payload /api/engine-capabilities serves", async (t) => {
    // Same declaration, same source object. If the two endpoints ever
    // answer different declarations there are two truths in webui, and
    // this assertion is what stops that.
    await setupMocks(t, { acp: { getMcodeServerInfo: () => AGENT_INFO } });
    const read = await readEngineCapabilityView({ transport: RUNTIME });
    // The read's key set, asserted exactly: the ACP wire table is gone
    // from this layer, and a `wire` field reappearing here would put a
    // second "what can the engine do" answer back in the facade.
    assert.deepEqual(Object.keys(read), [
      "declaration",
      "unavailable",
      "provider",
      "providerFor",
      "engineTransport",
      "agent",
      "source",
      "gate",
      "transport",
    ]);
    assert.deepEqual(Object.keys(read.declaration), [...ENGINE_CAPABILITY_KEYS]);
    assert.equal(read.declaration, LOCAL_RUNTIME_V2_CAPABILITIES);
    assert.deepEqual(
      read.unavailable,
      summarizeUnavailableCapabilities(LOCAL_RUNTIME_V2_CAPABILITIES),
    );
    assert.equal(read.provider, "local-runtime-v2");
    assert.equal(read.engineTransport, "runtime");
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
        const read = await readEngineCapabilityView({ transport });
      assert.equal(read.providerFor, expected);
      // And the two halves cannot disagree: `providerFor: "transport"`
      // with a provider the transport does not own is the lie.
      assert.equal(read.providerFor === "transport", transport === RUNTIME);
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
    const { MCODE_WEBUI_TRANSPORT } = await import(absPath("lib/config.js"));
    const read = await readEngineCapabilityView({ transport: "" });
    assert.equal(read.transport, MCODE_WEBUI_TRANSPORT);
    assert.equal(
      read.providerFor,
      MCODE_WEBUI_TRANSPORT === RUNTIME ? "transport" : "default",
    );
  });

  test("the declaration is forwarded by IDENTITY, and there is no ACP wire field", async (t) => {
    // A copy would be a second thing that can drift from the reviewed
    // declaration, which is the failure this endpoint had before M3-B4.
    // Identity pins the forwarding; the absence assertion pins the
    // replacement, so re-adding `MCODE_ACP_CAPABILITIES` anywhere in
    // this layer is a red bar rather than a silent second answer.
    await setupMocks(t, { acp: {} });
    const read = await readEngineCapabilityView({ transport: RUNTIME });
    assert.equal(read.declaration, LOCAL_RUNTIME_V2_CAPABILITIES);
    assert.equal("wire" in read, false);
    // And the facade must not even REACH for the rpc module any more:
    // the field it used to carry is the only reason it did. Asserted on
    // the SOURCE, because an unused import is behaviourally inert and no
    // behavioural test can tell it apart from a clean module — but it
    // would put `lib/mcode-rpc.js` (and its `acp.mjs` / settings chain)
    // back on the lazy-import path of a boot-reachable module for
    // nothing. A static tripwire is the honest instrument here.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL(absPath("engine/capability-reads.js"))),
      "utf8",
    );
    // Matched on the IMPORT FORM, not the bare file name: this module's
    // header deliberately names `lib/mcode-rpc.js` in prose (the debt
    // note, the boot-path note), and a tripwire that fired on the prose
    // would be a tripwire nobody could satisfy.
    assert.equal(
      /\bimport\s*\(?\s*["'][^"']*lib\/mcode-rpc\.js/.test(source),
      false,
      "capability-reads.js must not import lib/mcode-rpc.js — the ACP wire table is no longer part of this read",
    );
    // The constant itself is untouched; it is simply unconsumed (see
    // the KNOWN DEBT note in the module header).
    const rpc = await import(absPath("lib/mcode-rpc.js"));
    assert.equal(typeof rpc.MCODE_ACP_CAPABILITIES, "object");
  });

  test("the gate is evaluated and reported, and never blocks the read", async (t) => {
    await setupMocks(t, { acp: {} });
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
// 4. The route — the REPLACEMENT, pinned key by key
// ---------------------------------------------------------------------------

describe("handleCapabilities — capabilities is the engine-capabilities view", () => {
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

  const DECLARATION = { sessionCrud: { level: "full" } };
  const UNAVAILABLE = { none: [], partial: [] };
  const VIEW = {
    declaration: DECLARATION,
    unavailable: UNAVAILABLE,
    provider: "local-runtime-v2",
    providerFor: "transport",
    engineTransport: "runtime",
    agent: { version: "0.5.5", name: "mcode", title: "Mcode" },
  };
  const stub = () => ({ ...VIEW, source: "declaration", gate: {}, transport: RUNTIME });

  test("the response key order is the endpoint's, in four `capabilities*` siblings", async (t) => {
    // The four `capabilities*` keys form one group — declaration, which
    // provider answered, how it was chosen, the derived roll-up — and
    // `notes` stays last. A route that nested them under an `engine`
    // key, or that ordered them differently, is a contract change the
    // key-set assertion catches.
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => stub() });
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
      "capabilitiesProvider",
      "capabilitiesProviderFor",
      "capabilitiesUnavailable",
      "notes",
    ]);
  });

  test("`capabilities` IS the 14-key declaration, and the ACP wire table is gone", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => stub() });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    assert.equal(body.ok, true);
    // The declared taxonomy replaced the flat `{method: boolean}` one.
    // The old accessors are asserted ABSENT: a consumer that still read
    // `capabilities.set_mode` must get `undefined` and fail loudly, not
    // silently receive a truthy object field.
    for (const gone of ["set_mode", "set_config_option", "cancel", "activate", "fork", "resume", "delete", "load", "close", "list", "new", "prompt"]) {
      assert.equal(gone in body.capabilities, false, `capabilities.${gone} must be gone`);
    }
    // The four group members, each forwarded as the facade gave them.
    // `deepEqual`, not identity: the body has been through
    // `JSON.parse`, so reference identity is gone by construction — the
    // identity assertion that actually matters (the facade forwarding
    // the reviewed declaration rather than a copy) lives in section 3,
    // one layer below the JSON.
    assert.deepEqual(body.capabilities, DECLARATION);
    assert.equal(body.capabilitiesProvider, "local-runtime-v2");
    assert.equal(body.capabilitiesProviderFor, "transport");
    assert.deepEqual(body.capabilitiesUnavailable, UNAVAILABLE);
    // The `initialize` mirror is untouched by all of this.
    assert.equal(body.mcodeVersion, "0.5.5");
    assert.equal(body.mcodeName, "mcode");
    assert.equal(body.mcodeTitle, "Mcode");
    // `notes` is route-owned prose about webui's own routes; the facade
    // never restates it, so it is still exactly these five strings.
    assert.deepEqual(Object.keys(body.notes), ["set_mode", "set_config_option", "cancel", "activate", "fork"]);
  });

  test("the declaration appears EXACTLY ONCE in the serialised body", async (t) => {
    // The reason the `engine` key this batch first shipped was removed:
    // with the declaration already under `capabilities`, an `engine`
    // block carrying it again would put the same 14 keys in the
    // response twice, and a consumer could not tell which one is the
    // contract. This counts them structurally, not textually.
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => stub() });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    const asJson = JSON.stringify(DECLARATION);
    const carriers = Object.entries(body).filter(([, v]) => JSON.stringify(v) === asJson);
    assert.deepEqual(carriers.map(([k]) => k), ["capabilities"]);
    // And no nested key repeats it either: one declaration, one home.
    assert.equal(JSON.stringify(body).split(asJson).length - 1, 1);
    assert.equal("engine" in body, false);
  });

  test("the route adds nothing to the view and leaks none of its bookkeeping", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, { readEngineCapabilityView: async () => stub() });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    // A route that re-projected either half would be a second place for
    // the taxonomy to be reshaped; `deepEqual` is the strongest
    // statement available after `JSON.parse`, and section 3 pins the
    // reference identity one layer down.
    assert.deepEqual(body.capabilities, VIEW.declaration);
    assert.deepEqual(body.capabilitiesUnavailable, VIEW.unavailable);
    // The facade's own bookkeeping (`source`, `gate`, the ambient
    // `transport`, the provider's `engineTransport`) is diagnostic
    // vocabulary, not part of this endpoint's contract.
    for (const key of ["source", "gate", "engineTransport"]) {
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
    const route = await loadRoute();
    const res = mkRes();
    await route.handleCapabilities(null, res);
    const body = JSON.parse(res.written[1].body);
    assert.equal(body.capabilitiesProvider, "local-runtime-v2");
    // The real view must SAY whether it is standing in. Under the
    // default `acp` transport that is `"default"`; reporting
    // `"transport"` there would be the one lie this endpoint cannot
    // afford, because the declaration it would attribute to a connected
    // engine came from a provider that transport never chose. The
    // expectation follows the ambient transport so the control holds on
    // both gate legs.
    const { MCODE_WEBUI_TRANSPORT } = await import(absPath("lib/config.js"));
    assert.equal(
      body.capabilitiesProviderFor,
      MCODE_WEBUI_TRANSPORT === "runtime" ? "transport" : "default",
    );
    // `setupMocks`'s acp holder is process-global and an earlier case
    // left the agent mirror in it, so the version here is the real
    // `initialize` mirror's, not the fixture's.
    assert.equal(body.mcodeVersion, "0.5.5");
    // And the declaration served is the REAL reviewed one, key for key.
    assert.deepEqual(Object.keys(body.capabilities), [...ENGINE_CAPABILITY_KEYS]);
    assert.deepEqual(body.capabilities, LOCAL_RUNTIME_V2_CAPABILITIES);
    assert.equal(body.capabilitiesUnavailable.none.length >= 1, true);
  });
});
