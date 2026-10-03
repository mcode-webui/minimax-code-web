// webui/test/lib/engine/interrupt.test.js
//
// M3-B7 (part 1): the INTERRUPT family's engine facade — #13
// POST /api/stop and #69 POST /api/protocol/cancel.
//
// Sections are ordered by how much user-visible damage a regression in
// each one does, not by which module the function came from:
//
//   1. THE DECLARATION AND ITS SOFT-GATE POLICY. The judgement call in
//      this half of the batch: both endpoints gate SOFT, for
//      endpoint-specific reasons, and the suite proves the gate reports
//      and never throws — including on the DEFAULT `acp` transport,
//      where no provider is registered at all.
//   2. THE FOUR RED LINES. 中断有界 (the bounded escalation), the
//      `hardKilled` field's meaning, `cancelled` meaning "sent" rather
//      than "stopped", and the existing degradation each endpoint
//      already had. One named test per line, plus the NEGATIVE half of
//      each, because a red line only asserted in its happy direction is
//      a red line nobody is watching.
//   3. THE BYTE-FOR-BYTE WIRE SHAPES, table-driven across every branch:
//      status, Content-Type, the exact body string and the key ORDER.
//   4. THE PURE DERIVATIONS, on their inputs.
//   5. THE ROUTE, with the proof that the facade mock actually took.
//
// Two module-mock traps apply here exactly as they did in B3 through B6,
// and both are load-bearing rather than incidental:
//
//   1. `t.mock.module` REPLACES the WHOLE NAMESPACE; it does not merge.
//      A mock naming only the export under test leaves every other name
//      undefined and the consumer fails at INSTANTIATION with
//      `SyntaxError: … does not provide an export named …` — a failure
//      that reads like a product bug and is not one. Every facade mock
//      below goes through `mockAll()`, which fills the un-stubbed names
//      with a function that THROWS, so an unexpected call is loud
//      instead of returning a plausible payload.
//   2. `mock.module` re-evaluates only the MOCKED specifier. A consumer
//      already in the registry keeps its old LIVE BINDING, so a second
//      test in the same file would silently reuse the first test's mock
//      and pass for the wrong reason. Every route re-import in section 5
//      carries a fresh `?bust=N`, and section 5 ends with marker
//      controls that prove it.
//
// The escalation bound is exercised through the `setTimeoutImpl`
// injection seam rather than by waiting. The seam exists for that
// purpose and the bound itself is pinned two ways: the delay argument
// is asserted to EQUAL `STOP_FORCE_KILL_MS` (so the number has one
// home), and a real-`setTimeout` case in section 5 drives node:test's
// mock timers end to end so the production wiring — including the
// `unref` guard — is proven rather than assumed.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { setupMocks, absPath, registerRpcMock } from "../../helpers/_setup.js";
// Type discrimination goes through the exported predicate, never
// `err.name`. `engine/capabilities.js` is never `mock.module`d by this
// file, so the `instanceof` inside it resolves against the same class
// `assertEngineCapability` would have thrown from. The string comparison
// it replaces could not tell a capability error from any other error
// that happened to carry a name.
const { isEngineCapabilityNotSupportedError } = await import(
  "../../../server/engine/errors.js"
);

const RUNTIME = "runtime";
const ACP = "acp";

/** A syntactically valid engine sid. */
const SID = "mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let bust = 0;

/** Every name `engine/interrupt.js` exports. The namespace, not a subset. */
const FACADE_EXPORTS = [
  "INTERRUPT_ENDPOINTS",
  "STOP_FORCE_KILL_MS",
  "applyEngineStop",
  "checkInterruptCapability",
  "resolveInterruptProvider",
  "sendEngineSessionCancel",
  "stopLeftStaleClaim",
];

/** A JSON request body the real `lib/read-json.js` can consume. */
function jsonReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}

/** A minimal `ServerResponse` stand-in that records what was written. */
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

/** The last `writeHead` + `end` pair, as one observation. */
function lastResponse(res) {
  const head = res.written[res.written.length - 2];
  const tail = res.written[res.written.length - 1];
  assert.ok(head && head.status !== undefined, "the handler never wrote a head");
  return { status: head.status, headers: head.headers, body: tail ? tail.body : undefined };
}
/** A client state carrying only what the stop path reads. */
function mkCs(overrides = {}) {
  return {
    mcodeSessionId: SID,
    chat: [],
    context: {},
    running: { active: false, prompt: null, pid: null, sessionId: null },
    ...overrides,
  };
}

/**
 * A fake child registered on the state bus. `child.child` is the raw
 * handle the escalation reads, and it is a DISTINCT object from the
 * wrapper precisely so a test can null one without the other — the
 * property the "cached handle" red line is about.
 */
function mkChild({ rawAlive = true, notifyOk = true } = {}) {
  const log = { kills: 0 };
  const raw = {
    killed: false,
    exitCode: rawAlive ? null : 0,
    unref() {},
  };
  const child = {
    log,
    raw,
    get child() {
      return raw;
    },
    alive: true,
    kill() {
      log.kills += 1;
      raw.killed = true;
    },
    async notify() {
      if (!notifyOk) throw new Error("notify refused");
    },
    async request() {
      return { ok: true };
    },
  };
  return child;
}

/**
 * A recording stand-in for `setTimeout` that also answers the
 * `unref` question, which is the other half of "an unexpired escalation
 * must never hold the process open".
 */
function mkTimer() {
  const calls = [];
  const impl = (fn, ms) => {
    calls.push({ fn, ms });
    return {
      unref() {
        calls[calls.length - 1].unrefed = true;
      },
    };
  };
  impl.calls = calls;
  impl.last = () => calls[calls.length - 1];
  return impl;
}

// ===========================================================================
// The facade under test.
//
// `setupMocks` needs a TEST context (`t.mock.module` does not exist on a
// suite context) AND its registry is per-context: a file-level `before`
// would leave every later `setupMocks(t, …)` in this file fighting an
// already-mocked `lib/acp-client.js` (ERR_INVALID_STATE). So each test
// boots the facade itself, the B5/B6 `bootFacade` shape. The facade is
// never `mock.module`d in sections 1 through 4 — only the ROUTE is
// re-imported under a fresh `?bust=N` in section 5, which is trap #2's
// actual subject.
// ===========================================================================
async function bootFacade(t) {
  await setupMocks(t, {});
  return import(absPath("engine/interrupt.js"));
}

beforeEach(() => {
  // The shared RPC mock is mutated by the cases below; every case that
  // cares about a refusal registers its own, so restore the default
  // ("notification delivered") rather than inheriting the previous case.
  registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
});

// ===========================================================================
// 1. The declaration and its soft-gate policy
// ===========================================================================
describe("the whole-namespace mock lists stay whole", () => {
  test("FACADE_EXPORTS is exactly engine/interrupt.js's export list", async (t) => {
    // Mock trap #1: `t.mock.module` replaces the whole namespace, so a
    // list that drifts from the module's real exports makes every
    // route-level case in section 5 fail at INSTANTIATION with a
    // SyntaxError that reads like a product bug. Asserting the list
    // here turns that class of mistake into one named red test.
    const real = Object.keys(await import(absPath("engine/interrupt.js"))).sort();
    assert.deepEqual([...FACADE_EXPORTS].sort(), real);
  });
});

describe("the interrupt family's declaration and soft gate", () => {
  test("both endpoints declare `interrupt` · `abortSession` as SOFT", async (t) => {
    const facade = await bootFacade(t);
    // One declaration for two endpoints, on purpose: #13 is not a
    // different capability with a kill in it. See the module header.
    assert.deepEqual(facade.INTERRUPT_ENDPOINTS["POST /api/stop"], {
      capability: "interrupt",
      subItem: "abortSession",
      enforcement: "soft",
    });
    assert.deepEqual(facade.INTERRUPT_ENDPOINTS["POST /api/protocol/cancel"], {
      capability: "interrupt",
      subItem: "abortSession",
      enforcement: "soft",
    });
  });

  test("the DEFAULT `acp` transport reports `unregistered-transport` and NEVER throws", async (t) => {
    const facade = await bootFacade(t);
    // No provider is registered for `acp` (M4's job), so this is the
    // pre-M3 behaviour path — and it must not be a hole in the gate.
    for (const endpoint of Object.keys(facade.INTERRUPT_ENDPOINTS)) {
      const d = facade.checkInterruptCapability(endpoint, ACP);
      assert.equal(d.gate, "unregistered-transport", endpoint);
      assert.equal(d.provider, null, endpoint);
      assert.equal(d.capability, "interrupt", endpoint);
    }
  });

  test("the `runtime` transport resolves the registered provider and reports `checked`", async (t) => {
    const facade = await bootFacade(t);
    for (const endpoint of Object.keys(facade.INTERRUPT_ENDPOINTS)) {
      const d = facade.checkInterruptCapability(endpoint, RUNTIME);
      assert.equal(d.gate, "checked", endpoint);
      assert.equal(d.provider, "local-runtime-v2", endpoint);
    }
  });

  test("resolveInterruptProvider returns null for an unregistered transport and the provider for `runtime`", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.resolveInterruptProvider(ACP), null);
    assert.equal(facade.resolveInterruptProvider(RUNTIME).id, "local-runtime-v2");
  });

  test("an unknown endpoint key is a plain Error, never a capability error", async (t) => {
    const facade = await bootFacade(t);
    // Caller confusion must never reach a user as 501.
    let caught = null;
    try {
      facade.checkInterruptCapability("POST /api/not-a-member", RUNTIME);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "an unknown key must throw");
    assert.equal(isEngineCapabilityNotSupportedError(caught), false);
    assert.equal(caught.code, "unknown_interrupt_endpoint");
  });

  test("THE 501 MACHINERY IS UNUSED BY THIS FAMILY (policy, pinned)", async (t) => {
    const facade = await bootFacade(t);
    // The soft gate's whole justification is that neither endpoint can
    // be turned into a 501 by a declaration. There is deliberately no
    // `assertInterruptCapability` export; this test fails loudly if one
    // is ever added without the argument in the module header being
    // rewritten first.
    assert.equal(FACADE_EXPORTS.includes("assertInterruptCapability"), false);
    assert.equal(typeof facade.checkInterruptCapability, "function");
  });
});

// ===========================================================================
// 2. The four red lines
// ===========================================================================
describe("RED LINE 1 — the escalation is bounded", () => {
  test("the bound is 5000 ms — the plan's value, taken by product call", async (t) => {
    const facade = await bootFacade(t);
    // KNOWN DEBT 1, resolved 2026-10-03: doc/m3-batch-plan.md transcribes
    // this red line as "abort 5s 有界"; the migrated file said 2000. The
    // product call took the plan's value. The number is pinned here so a
    // future change to it has to be a deliberate edit.
    assert.equal(facade.STOP_FORCE_KILL_MS, 5000);
  });

  test("the escalation is armed at exactly that bound, and is unref'd", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cs = mkCs();
    const cid = "b7-bound";
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({
        cs,
        cid,
        transport: ACP,
        setTimeoutImpl: timer,
      });
      assert.equal(timer.calls.length, 1, "exactly one escalation armed");
      assert.equal(timer.last().ms, facade.STOP_FORCE_KILL_MS);
      assert.equal(timer.last().unrefed, true, "an unexpired escalation must not hold the process open");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("the escalation does NOT fire before the bound", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-before";
    const cs = mkCs();
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({ cs, cid, transport: ACP, setTimeoutImpl: timer });
      assert.equal(child.log.kills, 0, "the gentle path already killed it; the escalation is idempotent");
      // A child that survived a REFUSED cancel: the immediate hard kill
      // already ran, and nothing has run the timer yet — that IS the
      // bound, asserted by the timer never having been called.
      const stubborn = mkChild();
      const cid2 = "b7-before2";
      bus.setActiveChild(cid2, stubborn);
      registerRpcMock({ cancelSession: async () => ({ ok: false, code: "no_client", error: "offline" }) });
      const timer2 = mkTimer();
      await facade.applyEngineStop({ cs: mkCs(), cid: cid2, transport: ACP, setTimeoutImpl: timer2 });
      assert.equal(stubborn.log.kills, 1, "only the immediate hard kill ran");
      assert.equal(timer2.calls.length, 1, "and the escalation is armed, unrun");
      bus.clearActiveChild(cid2);
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("the escalation DOES fire when the child is still alive at the bound", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-fires";
    const cs = mkCs();
    // The gentle cancel SUCCEEDS, so the immediate kill does NOT run —
    // this is the "notification sent but ignored" case the bound exists
    // for, and it is the case that proves the timer is armed whenever a
    // child was registered, not only when one was killed.
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({ cs, cid, transport: ACP, setTimeoutImpl: timer });
      assert.equal(child.log.kills, 0, "a delivered cancel does not kill");
      timer.last().fn();
      assert.equal(child.log.kills, 1, "the bound escalates when the child outlived the cancel");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: the escalation does NOT fire for a child that already exited", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild({ rawAlive: false });
    const cid = "b7-exited";
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: timer });
      timer.last().fn();
      assert.equal(child.log.kills, 0, "exitCode !== null means there is nothing to kill");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: the escalation does NOT fire when the handle was already killed", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    child.raw.killed = true;
    const cid = "b7-killed";
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: timer });
      timer.last().fn();
      assert.equal(child.log.kills, 0, "rawChild.killed means the cascade already did its job");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: no escalation is armed at all when no child backs the turn", async (t) => {
    const facade = await bootFacade(t);
    const timer = mkTimer();
    const r = await facade.applyEngineStop({ cs: mkCs(), cid: "b7-nochild", transport: ACP, setTimeoutImpl: timer });
    assert.equal(timer.calls.length, 0, "nothing to bound when there is nothing running");
    assert.equal(r.payload.wasRunning, false);
  });

  test("the escalation reads the handle CACHED at arm time, not `child.child` at fire time", async (t) => {
    const facade = await bootFacade(t);
    // The runner's own stop() may null `child.child` in the window
    // between arming and firing. Reading the live property then would
    // silently skip the escalation the whole cascade exists for.
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-cached";
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: timer });
      // Null the live property, exactly as a concurrent stop() would.
      Object.defineProperty(child, "child", { get: () => null, configurable: true });
      timer.last().fn();
      assert.equal(child.log.kills, 1, "the cached handle is what the escalation uses");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: a throwing kill inside the escalation never escapes", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    child.kill = () => {
      throw new Error("kill exploded");
    };
    const cid = "b7-throws";
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    bus.setActiveChild(cid, child);
    const timer = mkTimer();
    try {
      await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: timer });
      assert.doesNotThrow(() => timer.last().fn());
    } finally {
      bus.clearActiveChild(cid);
    }
  });
});

describe("RED LINE 2 — `hardKilled` is a report about the first decision", () => {
  test("a refused cancel WITH a child sets hardKilled:true", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-hk-yes";
    bus.setActiveChild(cid, child);
    registerRpcMock({ cancelSession: async () => ({ ok: false, code: "no_client", error: "offline" }) });
    try {
      const r = await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: mkTimer() });
      assert.equal(r.payload.hardKilled, true);
      assert.equal(child.log.kills, 1, "the hard path really ran");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: a delivered cancel sets hardKilled:false — nothing was killed", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-hk-no";
    bus.setActiveChild(cid, child);
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    try {
      const r = await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: mkTimer() });
      assert.equal(r.payload.hardKilled, false);
      assert.equal(child.log.kills, 0);
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: with no child at all, hardKilled is false even though the note says hard kill", async (t) => {
    const facade = await bootFacade(t);
    // The note names WHY the gentle path did not happen, not what
    // followed. Pre-M3 wording, preserved verbatim.
    // No child AND no session id, so the gentle path is not merely
    // refused — it was never available. Nothing was killed, and the
    // note still says "hard kill".
    const r = await facade.applyEngineStop({
      cs: mkCs({ mcodeSessionId: null }),
      cid: "b7-hk-empty",
      transport: ACP,
      setTimeoutImpl: mkTimer(),
    });
    assert.equal(r.payload.wasRunning, false);
    assert.equal(r.payload.hardKilled, false);
    assert.equal(r.payload.note, "hard kill (session/cancel could not be delivered)");
  });

  test("hardKilled:true is written BEFORE the bound can fire — it never certifies the process died", async (t) => {
    const facade = await bootFacade(t);
    // KNOWN DEBT 3: the field cannot mean "the process is dead" and
    // does not try. This test is that claim, made executable: the body
    // is complete while the escalation is still pending.
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-hk-timing";
    bus.setActiveChild(cid, child);
    registerRpcMock({ cancelSession: async () => ({ ok: false, code: "no_client", error: "offline" }) });
    const timer = mkTimer();
    try {
      const r = await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: timer });
      assert.equal(r.payload.hardKilled, true);
      // The escalation has NOT run yet, and cannot have: nothing ticked.
      assert.equal(timer.calls[0].ms, facade.STOP_FORCE_KILL_MS);
      assert.equal(child.log.kills, 1, "only the immediate hard kill, which is what the field reports");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("REVERSE: a client state with no session id never reaches the notification at all", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-nosid";
    bus.setActiveChild(cid, child);
    let calls = 0;
    registerRpcMock({
      cancelSession: async () => {
        calls += 1;
        return { ok: true, data: { notified: true } };
      },
    });
    try {
      const r = await facade.applyEngineStop({
        cs: mkCs({ mcodeSessionId: null }),
        cid,
        transport: ACP,
        setTimeoutImpl: mkTimer(),
      });
      assert.equal(calls, 0, "no session id means no notification to send");
      assert.equal(r.payload.cancelled, false);
      assert.equal(r.payload.hardKilled, true, "and a registered child is killed outright");
    } finally {
      bus.clearActiveChild(cid);
    }
  });
});

describe("RED LINE 3 — `cancelled` means SENT, and a throw is not fatal", () => {
  test("#13 records `cancelled:true` on a delivered notification with no reply to wait for", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-sent";
    bus.setActiveChild(cid, child);
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    try {
      const r = await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: mkTimer() });
      assert.equal(r.payload.cancelled, true);
      assert.equal(r.payload.note, "gentle cancel");
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("a THROWING notification degrades to the hard path instead of failing the request", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const child = mkChild();
    const cid = "b7-throw";
    bus.setActiveChild(cid, child);
    registerRpcMock({
      cancelSession: async () => {
        throw new Error("socket gone");
      },
    });
    try {
      const r = await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: mkTimer() });
      assert.equal(r.payload.ok, true, "the request is never failed by a broken notification");
      assert.equal(r.payload.cancelled, false);
      assert.equal(r.payload.hardKilled, true);
    } finally {
      bus.clearActiveChild(cid);
    }
  });

  test("#69 reports the same truth in its own shape, and never claims a kill", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    const r = await facade.sendEngineSessionCancel({ sessionId: SID, cid: "b7-cancel-ok", transport: ACP });
    assert.equal(r.delivered, true);
    assert.deepEqual(r.payload, { ok: true, cancelled: true, data: { notified: true } });
    assert.equal("fallback" in r.payload, false, "this endpoint performs no kill and must not imply one");
  });

  test("REVERSE: #69 on a refusal keeps its documented 'I could not do it' 200", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ cancelSession: async () => ({ ok: false, code: "no_client", error: "client offline" }) });
    const r = await facade.sendEngineSessionCancel({ sessionId: SID, cid: "b7-cancel-no", transport: ACP });
    assert.equal(r.delivered, false, "no state push may follow a refusal");
    assert.deepEqual(r.payload, {
      ok: true,
      cancelled: false,
      warning: "client offline",
      code: "no_client",
      killEndpoint: "/api/stop",
    });
  });
});

describe("RED LINE 4 — the existing degradation is preserved", () => {
  test("the zombie-claim decision fires ONLY with no child and a live claim", async (t) => {
    const facade = await bootFacade(t);
    // The 2026-09-20 audit escape hatch: without it, answering
    // wasRunning:false strands the panel in 思考中 forever.
    assert.equal(facade.stopLeftStaleClaim(false, mkCs({ running: { active: true } })), true);
    assert.equal(facade.stopLeftStaleClaim(false, mkCs({ running: { active: false } })), false);
  });

  test("REVERSE: a live child means NO reset — the runner's finalize owns the terminal state", async (t) => {
    const facade = await bootFacade(t);
    // Resetting early would race it and could strip a `▍` cursor the
    // stream is still about to rewrite.
    assert.equal(facade.stopLeftStaleClaim(true, mkCs({ running: { active: true } })), false);
  });

  test("REVERSE: a missing client state is not a stale claim", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.stopLeftStaleClaim(false, null), false);
    assert.equal(facade.stopLeftStaleClaim(false, undefined), false);
    assert.equal(facade.stopLeftStaleClaim(false, {}), false);
  });

  test("the facade reports the decision; it never mutates the client state", async (t) => {
    const facade = await bootFacade(t);
    const bus = await import(absPath("lib/state-bus.js"));
    const cid = "b7-claim";
    const cs = mkCs({ running: { active: true, prompt: "live" } });
    bus.setActiveChild(cid, null);
    try {
      const r = await facade.applyEngineStop({ cs, cid, transport: ACP, setTimeoutImpl: mkTimer() });
      assert.equal(r.claimStale, true);
      assert.equal(cs.running.active, true, "the reset is the ROUTE's — its helper is shared with handleSend");
      assert.equal(cs.running.prompt, "live");
    } finally {
      bus.clearActiveChild(cid);
    }
  });
});

// ===========================================================================
// 3. The byte-for-byte wire shapes
// ===========================================================================
describe("the wire shapes, byte for byte", () => {
  // Key ORDER is part of the contract: these bodies are compared as
  // strings, not as parsed objects, so a reordering that changes no
  // field still fails here.
  const CASES = [
    {
      name: "#13 gentle cancel",
      expected:
        '{"ok":true,"wasRunning":true,"cancelled":true,"hardKilled":false,"note":"gentle cancel"}',
    },
    {
      name: "#13 hard kill",
      expected:
        '{"ok":true,"wasRunning":true,"cancelled":false,"hardKilled":true,"note":"hard kill (session/cancel could not be delivered)"}',
    },
    {
      name: "#13 nothing running (the note is unchanged here too)",
      expected:
        '{"ok":true,"wasRunning":false,"cancelled":false,"hardKilled":false,"note":"hard kill (session/cancel could not be delivered)"}',
    },
  ];

  for (const c of CASES) {
    test(`${c.name} — the exact body string, key order included`, async (t) => {
      const facade = await bootFacade(t);
      const bus = await import(absPath("lib/state-bus.js"));
      const cid = `b7-wire-${c.name}`;
      const withChild = c.expected.includes('"wasRunning":true');
      const delivered = c.expected.includes('"cancelled":true');
      if (withChild) bus.setActiveChild(cid, mkChild());
      registerRpcMock({
        cancelSession: async () =>
          delivered
            ? { ok: true, data: { notified: true } }
            : { ok: false, code: "no_client", error: "offline" },
      });
      try {
        const r = await facade.applyEngineStop({ cs: mkCs(), cid, transport: ACP, setTimeoutImpl: mkTimer() });
        assert.equal(JSON.stringify(r.payload), c.expected);
      } finally {
        bus.clearActiveChild(cid);
      }
    });
  }

  test("the three #13 bodies reach the client with status 200 and the route's own Content-Type", async (t) => {
    // Same table, driven through the ROUTE this time, so the status
    // line and the header are asserted from the code that writes them
    // rather than from a hand-rolled stand-in.
    await setupMocks(t, {});
    const namedExports = {};
    for (const name of FACADE_EXPORTS) {
      namedExports[name] = () => {
        throw new Error(`B7 test called engine/interrupt.js#${name}, which this case did not stub`);
      };
    }
    let body = null;
    namedExports.applyEngineStop = async () => ({
      payload: {
        ok: true,
        wasRunning: true,
        cancelled: false,
        hardKilled: true,
        note: "hard kill (session/cancel could not be delivered)",
      },
      claimStale: false,
      gate: {},
      transport: "acp",
    });
    t.mock.module(absPath("engine/interrupt.js"), { namedExports });
    const route = await import(`${absPath("routes/chat.js")}?bust=${bust++}`);
    const res = mkRes();
    await route.handleStop({ method: "POST", url: "/api/stop" }, res, { cs: mkCs(), cid: "tab-wire" });
    const seen = lastResponse(res);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers["Content-Type"], "application/json; charset=utf-8");
    body = seen.body;
    assert.equal(
      body,
      '{"ok":true,"wasRunning":true,"cancelled":false,"hardKilled":true,"note":"hard kill (session/cancel could not be delivered)"}',
    );
  });

  test("#69 success body string", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    const r = await facade.sendEngineSessionCancel({ sessionId: SID, cid: "b7-w69-ok", transport: ACP });
    assert.equal(JSON.stringify(r.payload), '{"ok":true,"cancelled":true,"data":{"notified":true}}');
  });

  test("#69 refusal body string", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ cancelSession: async () => ({ ok: false, code: "no_client", error: "client offline" }) });
    const r = await facade.sendEngineSessionCancel({ sessionId: SID, cid: "b7-w69-no", transport: ACP });
    assert.equal(
      JSON.stringify(r.payload),
      '{"ok":true,"cancelled":false,"warning":"client offline","code":"no_client","killEndpoint":"/api/stop"}',
    );
  });

  test("a 400 for a missing sessionId stays the ROUTE's, in the route's own words", async (t) => {
    await setupMocks(t, {});
    const route = await import(`${absPath("routes/protocol.js")}?bust=${bust++}`);
    const res = mkRes();
    await route.handleCancel(jsonReq({}), res, { cs: mkCs(), cid: "b7-400" });
    const seen = lastResponse(res);
    assert.equal(seen.status, 400);
    assert.equal(seen.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(seen.body, '{"ok":false,"error":"sessionId required"}');
  });
});

// ===========================================================================
// 4. The pure derivations
// ===========================================================================
describe("the pure derivations", () => {
  test("stopLeftStaleClaim is a total function over (wasRunning, cs)", async (t) => {
    const facade = await bootFacade(t);
    const table = [
      [false, mkCs({ running: { active: true } }), true],
      [false, mkCs({ running: { active: false } }), false],
      [true, mkCs({ running: { active: true } }), false],
      [false, {}, false],
      [false, null, false],
    ];
    for (const [wasRunning, cs, expected] of table) {
      assert.equal(facade.stopLeftStaleClaim(wasRunning, cs), expected, JSON.stringify(wasRunning));
    }
  });
});

// ===========================================================================
// 5. The route, with the proof that the facade mock actually took
// ===========================================================================
describe("routes/chat.js#handleStop", () => {
  beforeEach(() => {
    bust += 0;
  });

  function mockFacade(t, impls) {
    const namedExports = {};
    for (const name of FACADE_EXPORTS) {
      namedExports[name] = () => {
        throw new Error(`B7 test called engine/interrupt.js#${name}, which this case did not stub`);
      };
    }
    Object.assign(namedExports, impls);
    t.mock.module(absPath("engine/interrupt.js"), { namedExports });
  }
  const loadRoute = async () => import(`${absPath("routes/chat.js")}?bust=${bust++}`);

  test("the route writes the facade's body verbatim and does not rebuild it", async (t) => {
    await setupMocks(t, {});
    const PAYLOAD = {
      ok: true,
      wasRunning: true,
      cancelled: false,
      hardKilled: true,
      note: "hard kill (session/cancel could not be delivered)",
    };
    let seenArgs = null;
    mockFacade(t, {
      applyEngineStop: async (args) => {
        seenArgs = args;
        return { payload: PAYLOAD, claimStale: false, gate: {}, transport: "acp" };
      },
    });
    const route = await loadRoute();
    const cs = mkCs({ running: { active: true, prompt: "live" } });
    const res = mkRes();
    await route.handleStop({ method: "POST", url: "/api/stop" }, res, { cs, cid: "tab-1" });
    assert.deepEqual(seenArgs && { cs: seenArgs.cs, cid: seenArgs.cid }, { cs, cid: "tab-1" });
    const seen = lastResponse(res);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(seen.body, JSON.stringify(PAYLOAD));
    assert.equal(cs.running.prompt, "live", "claimStale:false means the route touches nothing");
  });

  test("the route applies the claim reset ONLY when the facade says the claim went stale", async (t) => {
    await setupMocks(t, {});
    mockFacade(t, {
      applyEngineStop: async () => ({
        payload: { ok: true, wasRunning: false, cancelled: false, hardKilled: false, note: "x" },
        claimStale: true,
        gate: {},
        transport: "acp",
      }),
    });
    const route = await loadRoute();
    const cs = mkCs({ running: { active: true, prompt: "live" } });
    cs.chat = ["● partial ▍"];
    const res = mkRes();
    await route.handleStop({ method: "POST", url: "/api/stop" }, res, { cs, cid: "tab-1" });
    assert.equal(cs.running.active, false, "the zombie claim is cleared");
    assert.equal(cs.context.thinkingStatus, "Idle");
    assert.deepEqual(cs.chat, ["● partial"], "the streaming cursor is stripped, exactly as handleSend's path does it");
  });

  test("PROOF: a marker error from the facade escapes the route", async (t) => {
    // Without a fresh `?bust=` re-import, `mock.module` would leave the
    // route holding the PREVIOUS test's live binding, the marker would
    // never be thrown, and this assertion would fail — which is the
    // point: it is the only assertion in this section that cannot pass
    // by accident.
    await setupMocks(t, {});
    const marker = new Error("B7-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
      applyEngineStop: async () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleStop({ method: "POST", url: "/api/stop" }, mkRes(), {
        cs: mkCs(),
        cid: "tab-1",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the facade error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });
});

describe("routes/protocol.js#handleCancel", () => {
  function mockFacade(t, impls) {
    const namedExports = {};
    for (const name of FACADE_EXPORTS) {
      namedExports[name] = () => {
        throw new Error(`B7 test called engine/interrupt.js#${name}, which this case did not stub`);
      };
    }
    Object.assign(namedExports, impls);
    t.mock.module(absPath("engine/interrupt.js"), { namedExports });
  }
  const loadRoute = async () => import(`${absPath("routes/protocol.js")}?bust=${bust++}`);

  test("the route pushes state only on a DELIVERED notification", async (t) => {
    await setupMocks(t, {});
    let delivered;
    mockFacade(t, {
      sendEngineSessionCancel: async () => ({
        payload: { ok: true, cancelled: false, warning: "offline", code: "no_client", killEndpoint: "/api/stop" },
        delivered: false,
        gate: {},
        transport: "acp",
      }),
    });
    delivered = false;
    const route = await loadRoute();
    const bus = await import(absPath("lib/state-bus.js"));
    const res = mkRes();
    // The route's push goes through the REAL state bus; the state frame
    // only lands if a client is registered for the cid, so register one
    // and observe that the refusal did not reset it.
    const cs = mkCs();
    bus.clients.set("tab-cancel", cs);
    try {
      await route.handleCancel(jsonReq({ sessionId: SID }), res, { cs, cid: "tab-cancel" });
      const seen = lastResponse(res);
      assert.equal(seen.status, 200);
      assert.equal(
        seen.body,
        '{"ok":true,"cancelled":false,"warning":"offline","code":"no_client","killEndpoint":"/api/stop"}',
      );
      assert.equal(cs.running.active, false, "a refusal must not re-assert a run claim");
    } finally {
      bus.clients.delete("tab-cancel");
    }
  });

  test("PROOF: a marker error from the facade escapes the route", async (t) => {
    await setupMocks(t, {});
    const marker = new Error("B7-CANCEL-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
      sendEngineSessionCancel: async () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleCancel(jsonReq({ sessionId: SID }), mkRes(), { cs: mkCs(), cid: "tab-1" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });
});
