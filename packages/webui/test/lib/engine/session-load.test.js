// webui/test/lib/engine/session-load.test.js
//
// M3-B7 (part 2): the LOAD and ACTIVATE family's engine facade — #70
// POST /api/protocol/load-session and #71
// POST /api/protocol/activate-session.
//
// Sections are ordered by how much user-visible damage a regression in
// each one does, not by which module the function came from:
//
//   1. THE DECLARATION AND ITS SPLIT GATE POLICY. #70 gates HARD
//      (`sessionCrud` · `loadSession`), #71 gates SOFT. The soft half is
//      the consequential judgement call: hard-gating #71 would be
//      silently answering the activate-semantic-collapse question the
//      plan leaves open, so the suite proves the soft gate reports
//      `capability-absent` for a provider that declares nothing — the
//      branch the real registry cannot currently reach — and that the
//      endpoint still answers.
//   2. THE FOUR RED LINES. The activate response SHAPE (the collapse
//      decision this batch must not take), the existing status
//      degradations, the sidebar entry being downstream of the engine's
//      answer, and the activate ordering. One named test per line, plus
//      the NEGATIVE half of each.
//   3. THE BYTE-FOR-BYTE WIRE SHAPES.
//   4. THE PURE DERIVATIONS — the three status mappers and the wire-code
//      rewrite — table-driven, including rows no fixture reaches.
//   5. THE ROUTES, with the proof that the facade mock actually took AND
//      the proof that #70's capability error ESCAPES the route (that
//      escape is the mechanism the router's central 501 mapping
//      depends on).
//
// Two module-mock traps apply here exactly as they did in B3 through B6:
// `t.mock.module` REPLACES THE WHOLE NAMESPACE (so every facade mock
// goes through `mockAll()`, which fills un-stubbed names with a
// THROWER), and it re-evaluates only the MOCKED specifier (so every
// route re-import in section 5 carries a fresh `?bust=N`, and section 5
// ends with marker controls that prove it). `setupMocks` needs a TEST
// context and its registry is per-context, so every test boots the
// facade itself — the B5/B6 `bootFacade` shape — rather than sharing a
// file-level `before`.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  setupMocks,
  absPath,
  registerRpcMock,
  registerSessionsStore,
  getSessionsStore,
} from "../../helpers/_setup.js";
// Type discrimination goes through the exported predicate, never
// `err.name`: `name` is a writable instance property, so one stray
// upstream assignment would turn a 501 back into a soft failure — a
// failure mode that reads as a passing test.
const { isEngineCapabilityNotSupportedError } = await import(
  "../../../server/engine/errors.js"
);

const RUNTIME = "runtime";
const ACP = "acp";

/** A syntactically valid engine sid. */
const SID_A = "mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SID_B = "mvs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let bust = 0;

/** Every name `engine/session-load.js` exports. The namespace, not a subset. */
const FACADE_EXPORTS = [
  "SESSION_LOAD_ENDPOINTS",
  "activateEngineSession",
  "activateFailureStatus",
  "assertSessionLoadCapability",
  "checkSessionActivateCapability",
  "loadEngineSession",
  "loadFailureStatus",
  "loadFailureWireCode",
  "resolveSessionLoadProvider",
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

/** A client state carrying only what this family reads or writes. */
function mkCs(overrides = {}) {
  return {
    mcodeSessionId: null,
    chat: [],
    context: { tokens: 5, used: 6, percent: 7, thinkingStatus: "Busy" },
    running: { active: true, prompt: "live" },
    workspace: { dir: "/ws-A", branch: null, tree: null },
    ...overrides,
  };
}

/**
 * A whole-namespace mock in which every export THROWS.
 *
 * The names come from the module's SOURCE, never from evaluating it:
 * see the resetContext-ordering case for why evaluating
 * `lib/mcode-rpc.js` is not an option here. A stale list is not a
 * silent failure either — an export the mock omits is `undefined`, and
 * the consumer fails loudly at instantiation.
 */
function throwingNamespace(fileUrl) {
  const src = readFileSync(fileURLToPath(fileUrl), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  assert.ok(names.size > 0, `no export names parsed out of ${fileUrl}`);
  const out = {};
  for (const name of names) {
    out[name] = () => {
      throw new Error(`B7 test called ${fileUrl}#${name}, which this case did not stub`);
    };
  }
  return out;
}

/** Boot the facade with the shared webui module surface mocked. */
async function bootFacade(t) {
  await setupMocks(t, {});
  return import(absPath("engine/session-load.js"));
}

/**
 * Boot the facade against a PROVIDER THAT DECLARES NOTHING for
 * `sessionCrud`.
 *
 * The registry's two providers both declare `sessionCrud: full`, so the
 * soft gate's `capability-absent` branch is otherwise unreachable in a
 * test — and an unreachable branch is an unpinned one. `engine/index.js`
 * is mocked here for its WHOLE namespace (trap #1); `session-load.js` is
 * then imported FRESH so it picks the mock up as its live binding.
 */
async function bootFacadeWithProvider(t, capabilities) {
  await setupMocks(t, {});
  const namedExports = {};
  for (const name of [
    "ENGINE_CAPABILITY_KEYS",
    "DEFAULT_ENGINE_PROVIDER_ID",
    "getEngineProvider",
    "listEngineProviderIds",
    "assertEngineCapability",
    "summarizeUnavailableCapabilities",
    "validateEngineCapabilities",
    "getEngineCatalogueHost",
    "EngineCapabilityNotSupportedError",
    "engineCapabilityHttpResponse",
    "isEngineCapabilityNotSupportedError",
  ]) {
    namedExports[name] = () => {
      throw new Error(`B7 test called engine/index.js#${name}, which this case did not stub`);
    };
  }
  Object.assign(namedExports, {
    DEFAULT_ENGINE_PROVIDER_ID: "local-runtime-v2",
    getEngineProvider: (id = "local-runtime-v2") => ({
      id,
      transport: "runtime",
      capabilities,
    }),
  });
  t.mock.module(absPath("engine/index.js"), { namedExports });
  return import(`${absPath("engine/session-load.js")}?provider=${bust++}`);
}

/** A declaration in which `sessionCrud` is absent entirely. */
const NO_SESSION_CRUD = {
  sessionCrud: { level: "none", reason: "test: interface-absent" },
  interrupt: { level: "full" },
};

beforeEach(() => {
  // Restore the shared mocks every case relies on as a baseline.
  registerRpcMock({
    loadSession: async () => ({ ok: true, data: { sessionId: SID_A } }),
    activateSession: async () => ({ ok: true, data: {} }),
  });
  registerSessionsStore({ initial: [] });
});

// ===========================================================================
// 1. The declaration and its split gate policy
// ===========================================================================
describe("the whole-namespace mock lists stay whole", () => {
  test("FACADE_EXPORTS is exactly engine/session-load.js's export list", async (t) => {
    // Mock trap #1: `t.mock.module` replaces the whole namespace, so a
    // list that drifts from the module's real exports makes every
    // route-level case in section 5 fail at INSTANTIATION with a
    // SyntaxError that reads like a product bug. Asserting the list
    // here turns that class of mistake into one named red test.
    const real = Object.keys(await import(absPath("engine/session-load.js"))).sort();
    assert.deepEqual([...FACADE_EXPORTS].sort(), real);
  });
});

describe("the load/activate family's declaration and split gate", () => {
  test("#70 declares `sessionCrud` · `loadSession` as HARD", async (t) => {
    const facade = await bootFacade(t);
    assert.deepEqual(facade.SESSION_LOAD_ENDPOINTS["POST /api/protocol/load-session"], {
      capability: "sessionCrud",
      subItem: "loadSession",
      enforcement: "hard",
    });
  });

  test("#71 declares `sessionCrud` · `activateSession` as SOFT", async (t) => {
    const facade = await bootFacade(t);
    assert.deepEqual(facade.SESSION_LOAD_ENDPOINTS["POST /api/protocol/activate-session"], {
      capability: "sessionCrud",
      subItem: "activateSession",
      enforcement: "soft",
    });
  });

  test("the DEFAULT `acp` transport reports `unregistered-transport` for both", async (t) => {
    const facade = await bootFacade(t);
    for (const endpoint of Object.keys(facade.SESSION_LOAD_ENDPOINTS)) {
      const hard = facade.assertSessionLoadCapability(endpoint, ACP);
      assert.equal(hard.gate, "unregistered-transport", endpoint);
      assert.equal(hard.provider, null, endpoint);
      const soft = facade.checkSessionActivateCapability(endpoint, ACP);
      assert.equal(soft.gate, "unregistered-transport", endpoint);
    }
  });

  test("the `runtime` transport resolves the registered provider and reports `checked`", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(
      facade.assertSessionLoadCapability("POST /api/protocol/load-session", RUNTIME).gate,
      "checked",
    );
    assert.equal(
      facade.checkSessionActivateCapability("POST /api/protocol/activate-session", RUNTIME).gate,
      "checked",
    );
    assert.equal(facade.resolveSessionLoadProvider(RUNTIME).id, "local-runtime-v2");
    assert.equal(facade.resolveSessionLoadProvider(ACP), null);
  });

  test("an unknown endpoint key is a plain Error on BOTH gates, never a capability error", async (t) => {
    const facade = await bootFacade(t);
    for (const fn of [facade.assertSessionLoadCapability, facade.checkSessionActivateCapability]) {
      let caught = null;
      try {
        fn("POST /api/not-a-member", RUNTIME);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "an unknown key must throw");
      assert.equal(isEngineCapabilityNotSupportedError(caught), false);
      assert.equal(caught.code, "unknown_session_load_endpoint");
    }
  });

  test("the HARD gate throws EngineCapabilityNotSupportedError for a provider that declares nothing", async (t) => {
    const facade = await bootFacadeWithProvider(t, NO_SESSION_CRUD);
    let caught = null;
    try {
      facade.assertSessionLoadCapability("POST /api/protocol/load-session", RUNTIME);
    } catch (e) {
      caught = e;
    }
    assert.ok(isEngineCapabilityNotSupportedError(caught), "the hard gate must throw the structured error");
    assert.equal(caught.capability, "sessionCrud");
    assert.equal(caught.provider, "local-runtime-v2");
  });

  test("the SOFT gate REPORTS `capability-absent` for the same provider and never throws", async (t) => {
    const facade = await bootFacadeWithProvider(t, NO_SESSION_CRUD);
    const d = facade.checkSessionActivateCapability("POST /api/protocol/activate-session", RUNTIME);
    assert.equal(d.gate, "capability-absent");
    assert.equal(d.provider, "local-runtime-v2");
    assert.equal(d.enforcement, "soft");
  });
});

// ===========================================================================
// 2. The four red lines
// ===========================================================================
describe("RED LINE 1 — the activate response shape is NOT the collapse decision", () => {
  test("the success body is byte-for-byte the pre-M3 shape", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ activateSession: async () => ({ ok: true, data: { activated: true } }) });
    const r = await facade.activateEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(r.statusHint, 200);
    assert.equal(
      JSON.stringify(r.payload),
      `{"ok":true,"activeSessionId":"${SID_A}","data":{"activated":true}}`,
    );
    // Key ORDER included: the field order is part of the pinned string.
    assert.deepEqual(Object.keys(r.payload), ["ok", "activeSessionId", "data"]);
  });

  test("REVERSE: a provider with NO activate surface still gets that same 200 — the gate is soft", async (t) => {
    // This is the load-bearing half of the decision NOT being taken. A
    // hard gate would answer 501 here, which is one of the two
    // branches KNOWN DEBT 1 costs — and choosing it silently, from a
    // capability table, with no frontend work, is exactly what this
    // batch is not entitled to do.
    const facade = await bootFacadeWithProvider(t, NO_SESSION_CRUD);
    registerRpcMock({ activateSession: async () => ({ ok: true, data: { activated: true } }) });
    const r = await facade.activateEngineSession({ sessionId: SID_A, cs: mkCs(), transport: RUNTIME });
    assert.equal(r.gate.gate, "capability-absent");
    assert.equal(r.statusHint, 200, "soft means the pre-M3 answer survives");
    assert.equal(
      JSON.stringify(r.payload),
      `{"ok":true,"activeSessionId":"${SID_A}","data":{"activated":true}}`,
    );
  });

  test("the 501 this route can still answer is the PRE-EXISTING one, from `unsupported`", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ activateSession: async () => ({ ok: false, code: "unsupported", error: "no" }) });
    const r = await facade.activateEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(r.statusHint, 501);
    assert.equal(r.payload.code, "unsupported", "the RPC code, NOT the engine-gate body — two different 501s");
    assert.equal("capability" in r.payload, false);
    assert.equal("provider" in r.payload, false);
  });
});

describe("RED LINE 2 — the existing status degradations are preserved", () => {
  test("#70 answers 500 for `unsupported` — deliberately NOT 501", async (t) => {
    // The asymmetry with set-mode is pinned by the pre-existing suite
    // too; unifying them would be a behaviour change to two endpoints.
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: false, code: "unsupported", error: "no" }) });
    const r = await facade.loadEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(r.statusHint, 500);
  });

  test("#70 rewrites the engine's Resource-not-found code for the frontend", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({
      loadSession: async () => ({ ok: false, code: "resource_not_found", error: "Resource not found" }),
    });
    const r = await facade.loadEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(r.statusHint, 404);
    assert.equal(r.payload.code, "session_not_found");
  });

  test("REVERSE: a failure with NO code drops the key entirely, as it always did", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: false, error: "boom" }) });
    const r = await facade.loadEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(r.statusHint, 500);
    assert.equal(r.payload.code, undefined, "no code was invented");
    assert.equal(JSON.stringify(r.payload), '{"ok":false,"error":"boom"}');
  });

  test("a failed #71 leaves the client state completely untouched", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ activateSession: async () => ({ ok: false, code: "no_client", error: "offline" }) });
    const cs = mkCs({ mcodeSessionId: SID_B });
    const r = await facade.activateEngineSession({ sessionId: SID_A, cs, transport: ACP });
    assert.equal(r.statusHint, 503);
    assert.equal(cs.mcodeSessionId, SID_B, "a refused activate must not rebind the client");
    assert.equal(cs.context.tokens, 5, "and must not reset the context");
  });
});

describe("RED LINE 3 — the sidebar entry is DOWNSTREAM of the engine's answer", () => {
  test("a FAILED load creates no entry at all, even when one was requested", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: false, code: "no_client", error: "offline" }) });
    const r = await facade.loadEngineSession({
      sessionId: SID_A,
      createWebuiEntry: true,
      cs: mkCs(),
      transport: ACP,
    });
    assert.equal(r.statusHint, 503);
    assert.equal(getSessionsStore().length, 0, "no entry for a session the engine never loaded");
    assert.equal("webuiEntry" in r.payload, false, "the failure body has no such key");
  });

  test("a REFUSED capability gate never reaches the engine at all", async (t) => {
    const facade = await bootFacadeWithProvider(t, NO_SESSION_CRUD);
    let engineCalls = 0;
    registerRpcMock({
      loadSession: async () => {
        engineCalls += 1;
        return { ok: true, data: {} };
      },
    });
    await assert.rejects(
      facade.loadEngineSession({ sessionId: SID_A, createWebuiEntry: true, cs: mkCs(), transport: RUNTIME }),
      (e) => isEngineCapabilityNotSupportedError(e),
    );
    assert.equal(engineCalls, 0, "the gate runs BEFORE the dispatch — that is the whole point of it");
    assert.equal(getSessionsStore().length, 0);
  });

  test("a successful load with `createWebuiEntry` writes exactly one record", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: true, data: {} }) });
    let n = 0;
    const r = await facade.loadEngineSession({
      sessionId: SID_A,
      createWebuiEntry: true,
      cs: mkCs(),
      transport: ACP,
      newId: () => `webui-${++n}`,
    });
    assert.equal(r.statusHint, 200);
    assert.equal(getSessionsStore().length, 1);
    const entry = getSessionsStore()[0];
    assert.equal(entry.id, "webui-1");
    assert.equal(entry.mcodeSessionId, SID_A);
    assert.equal(entry.title, "Mcode session");
    assert.equal(entry.workspace, "/ws-A", "falls back to the client's workspace when no cwd was given");
    assert.deepEqual(entry.chat, []);
  });

  test("REVERSE: without `createWebuiEntry` the store is untouched and `webuiEntry` is null", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: true, data: {} }) });
    const r = await facade.loadEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(getSessionsStore().length, 0);
    assert.equal(r.payload.webuiEntry, null, "a literal null, not an omitted key — the wire shape pins it");
  });

  test("the entry is IDEMPOTENT on `mcodeSessionId`: a second call reuses the record", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: true, data: {} }) });
    let n = 0;
    const opts = {
      sessionId: SID_A,
      createWebuiEntry: true,
      cs: mkCs(),
      transport: ACP,
      newId: () => `webui-${++n}`,
    };
    const first = await facade.loadEngineSession(opts);
    const second = await facade.loadEngineSession(opts);
    assert.equal(first.payload.webuiEntry.id, "webui-1");
    assert.equal(second.payload.webuiEntry.id, "webui-1", "no duplicate sidebar entry for one conversation");
    assert.equal(getSessionsStore().length, 1);
  });

  test("an explicit cwd wins over the client's workspace, in BOTH places", async (t) => {
    const facade = await bootFacade(t);
    let seenCwd = null;
    registerRpcMock({
      loadSession: async (_sid, cwd) => {
        seenCwd = cwd;
        return { ok: true, data: {} };
      },
    });
    let n = 0;
    await facade.loadEngineSession({
      sessionId: SID_A,
      cwd: "/ws-explicit",
      createWebuiEntry: true,
      cs: mkCs(),
      transport: ACP,
      newId: () => `webui-${++n}`,
    });
    assert.equal(seenCwd, "/ws-explicit", "the engine is told the explicit cwd");
    assert.equal(getSessionsStore()[0].workspace, "/ws-explicit", "and the record is stamped with it too");
  });

  test("REVERSE: with no client state, `createWebuiEntry` writes nothing", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: true, data: {} }) });
    const r = await facade.loadEngineSession({ sessionId: SID_A, createWebuiEntry: true, transport: ACP });
    assert.equal(r.payload.webuiEntry, null);
    assert.equal(getSessionsStore().length, 0);
  });
});

describe("RED LINE 4 — the activate order is `mcodeSessionId` FIRST, `resetContext` SECOND", () => {
  test("`resetContext` observes the NEW session id", async (t) => {
    // This case does NOT use setupMocks, for two reasons that are both
    // load-bearing:
    //
    //   1. setupMocks registers its own `lib/sessions.js` mock, and
    //      `t.mock.module` refuses a second registration of the same
    //      specifier on one tracker (ERR_INVALID_STATE) — so the
    //      instrumented store this test needs would be unreachable.
    //   2. Evaluating the REAL `lib/mcode-rpc.js` to enumerate its
    //      exports pulls in the real `lib/acp-client.js`, which starts
    //      the ACP singleton child and leaves the test process unable
    //      to exit. An earlier draft of this case did exactly that; the
    //      export names are read from the SOURCE instead, which is both
    //      cheaper and free of side effects.
    //
    // Trap #1 still applies to both mocks: `mock.module` replaces the
    // whole namespace, so every name below is filled with a thrower and
    // only the three this case needs are overridden.
    const rpcExports = throwingNamespace(absPath("lib/mcode-rpc.js"));
    const sessionExports = throwingNamespace(absPath("lib/sessions.js"));
    let seenSidAtReset = "NOT-CALLED";
    Object.assign(sessionExports, {
      loadSessions: () => [],
      saveSessions: () => {},
      resetContext: (cs) => {
        seenSidAtReset = cs.mcodeSessionId;
        cs.context.tokens = 0;
      },
    });
    Object.assign(rpcExports, {
      activateSession: async () => ({ ok: true, data: {} }),
    });
    t.mock.module(absPath("lib/mcode-rpc.js"), { namedExports: rpcExports });
    t.mock.module(absPath("lib/sessions.js"), { namedExports: sessionExports });
    const facade = await import(absPath("engine/session-load.js"));
    const cs = mkCs({ mcodeSessionId: SID_B });
    await facade.activateEngineSession({ sessionId: SID_A, cs, transport: ACP });
    assert.equal(seenSidAtReset, SID_A, "reversing the two leaves the panel describing the session just left");
    assert.equal(cs.mcodeSessionId, SID_A);
    assert.equal(cs.context.tokens, 0, "and the reset really ran");
  });
});

// ===========================================================================
// 3. The byte-for-byte wire shapes
// ===========================================================================
describe("the wire shapes, byte for byte", () => {
  test("#70 success without an entry", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ loadSession: async () => ({ ok: true, data: { ignored: true } }) });
    const r = await facade.loadEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(JSON.stringify(r.payload), `{"ok":true,"sessionId":"${SID_A}","webuiEntry":null}`);
  });

  test("#70 failure body, with the rewritten code", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({
      loadSession: async () => ({ ok: false, code: "resource_not_found", error: "Resource not found" }),
    });
    const r = await facade.loadEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(JSON.stringify(r.payload), '{"ok":false,"error":"Resource not found","code":"session_not_found"}');
  });

  test("#71 failure body", async (t) => {
    const facade = await bootFacade(t);
    registerRpcMock({ activateSession: async () => ({ ok: false, code: "no_client", error: "offline" }) });
    const r = await facade.activateEngineSession({ sessionId: SID_A, cs: mkCs(), transport: ACP });
    assert.equal(JSON.stringify(r.payload), '{"ok":false,"error":"offline","code":"no_client"}');
  });

  test("both 400s stay the ROUTE's, in the route's own words", async (t) => {
    await setupMocks(t, {});
    const route = await import(`${absPath("routes/protocol.js")}?bust=${bust++}`);
    for (const handler of [route.handleLoadSession, route.handleActivateSession]) {
      const res = mkRes();
      await handler(jsonReq({}), res, { cs: mkCs(), cid: "cid-1" });
      const seen = lastResponse(res);
      assert.equal(seen.status, 400);
      assert.equal(seen.headers["Content-Type"], "application/json; charset=utf-8");
      assert.equal(seen.body, '{"ok":false,"error":"sessionId required"}');
    }
  });
});

// ===========================================================================
// 4. The pure derivations
// ===========================================================================
describe("the pure derivations", () => {
  test("loadFailureStatus — the whole table, including rows no fixture reaches", async (t) => {
    const facade = await bootFacade(t);
    const table = [
      ["no_client", 503],
      ["session_not_found", 404],
      ["resource_not_found", 404],
      ["invalid_params", 404],
      ["unsupported", 500],
      ["rpc_error", 500],
      // The numeric JSON-RPC form does NOT match `/not.found|invalid/`,
      // so it falls through to 500. Pre-M3 behaviour, pinned as-is —
      // see KNOWN DEBT 4 in the module header.
      ["-32002", 500],
      [undefined, 500],
      ["", 500],
    ];
    for (const [code, expected] of table) {
      assert.equal(facade.loadFailureStatus(code), expected, String(code));
    }
  });

  test("activateFailureStatus — `unsupported` is the one row that differs from load's", async (t) => {
    const facade = await bootFacade(t);
    const table = [
      ["unsupported", 501],
      ["no_client", 503],
      ["resource_not_found", 404],
      ["invalid_params", 404],
      ["rpc_error", 500],
      ["-32002", 500],
      [undefined, 500],
    ];
    for (const [code, expected] of table) {
      assert.equal(facade.activateFailureStatus(code), expected, String(code));
    }
    assert.notEqual(
      facade.activateFailureStatus("unsupported"),
      facade.loadFailureStatus("unsupported"),
      "the asymmetry is the endpoint's documented contract, not an accident",
    );
  });

  test("loadFailureWireCode — rewritten, passed through, or absent", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.loadFailureWireCode("resource_not_found"), "session_not_found");
    assert.equal(facade.loadFailureWireCode("no_client"), "no_client");
    assert.equal(facade.loadFailureWireCode(undefined), undefined);
    // The numeric JSON-RPC code passes through unchanged — the rewrite
    // only ever matched the string form. Pinned because a future edit
    // that "fixes" it is a wire change, not a refactor.
    assert.equal(facade.loadFailureWireCode("-32004"), "-32004");
  });
});

// ===========================================================================
// 5. The routes, with the proof that the facade mock actually took
// ===========================================================================
describe("routes/protocol.js — load-session and activate-session", () => {
  function mockFacade(t, impls) {
    const namedExports = {};
    for (const name of FACADE_EXPORTS) {
      namedExports[name] = () => {
        throw new Error(`B7 test called engine/session-load.js#${name}, which this case did not stub`);
      };
    }
    Object.assign(namedExports, impls);
    t.mock.module(absPath("engine/session-load.js"), { namedExports });
  }
  const loadRoute = async () => import(`${absPath("routes/protocol.js")}?bust=${bust++}`);

  test("#70: the route writes the facade's status and body, and pushes state on success", async (t) => {
    await setupMocks(t, {});
    let seenArgs = null;
    mockFacade(t, {
      loadEngineSession: async (args) => {
        seenArgs = args;
        return {
          payload: { ok: true, sessionId: "mvs_x", webuiEntry: null },
          statusHint: 200,
          gate: {},
          transport: "acp",
        };
      },
    });
    const route = await loadRoute();
    const cs = mkCs();
    const res = mkRes();
    await route.handleLoadSession(
      jsonReq({ sessionId: "mvs_x", cwd: "/ws-A", createWebuiEntry: true }),
      res,
      { cs, cid: "tab-1" },
    );
    assert.deepEqual(seenArgs, { sessionId: "mvs_x", cwd: "/ws-A", createWebuiEntry: true, cs });
    const seen = lastResponse(res);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(seen.body, '{"ok":true,"sessionId":"mvs_x","webuiEntry":null}');
  });

  test("#70: a failure status is written WITHOUT pushing state", async (t) => {
    await setupMocks(t, {});
    mockFacade(t, {
      loadEngineSession: async () => ({
        payload: { ok: false, error: "offline", code: "no_client" },
        statusHint: 503,
        gate: {},
        transport: "acp",
      }),
    });
    const route = await loadRoute();
    const bus = await import(absPath("lib/state-bus.js"));
    const cs = mkCs();
    bus.clients.set("tab-load", cs);
    try {
      const res = mkRes();
      await route.handleLoadSession(jsonReq({ sessionId: "mvs_x" }), res, { cs, cid: "tab-load" });
      const seen = lastResponse(res);
      assert.equal(seen.status, 503);
      assert.equal(seen.body, '{"ok":false,"error":"offline","code":"no_client"}');
      assert.equal(cs.running.active, true, "a failed load must not re-assert an at-rest frame");
    } finally {
      bus.clients.delete("tab-load");
    }
  });

  test("PROOF: #70's capability error ESCAPES the route, for the router's central 501", async (t) => {
    // The route must not catch it. A catch would turn "the engine
    // cannot do this" into a 500, which is the fake success the gate
    // exists to prevent — and it would be the ONLY endpoint in M3 to
    // swallow the structured error.
    await setupMocks(t, {});
    const marker = new Error("B7-LOAD-MOCK-WAS-NOT-HONOURED");
    marker.capability = "sessionCrud";
    mockFacade(t, {
      loadEngineSession: async () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleLoadSession(jsonReq({ sessionId: "mvs_x" }), mkRes(), {
        cs: mkCs(),
        cid: "tab-1",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the capability error — it must not have a catch here");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("#71: the route writes the facade's body and pushes state on success", async (t) => {
    await setupMocks(t, {});
    let seenArgs = null;
    mockFacade(t, {
      activateEngineSession: async (args) => {
        seenArgs = args;
        return {
          payload: { ok: true, activeSessionId: "mvs_x", data: {} },
          statusHint: 200,
          gate: {},
          transport: "acp",
        };
      },
    });
    const route = await loadRoute();
    const cs = mkCs();
    const res = mkRes();
    await route.handleActivateSession(jsonReq({ sessionId: "mvs_x" }), res, { cs, cid: "tab-1" });
    assert.deepEqual(seenArgs, { sessionId: "mvs_x", cs });
    const seen = lastResponse(res);
    assert.equal(seen.status, 200);
    assert.equal(seen.body, '{"ok":true,"activeSessionId":"mvs_x","data":{}}');
  });

  test("#71: the pre-existing 501 for `unsupported` still reaches the client", async (t) => {
    await setupMocks(t, {});
    mockFacade(t, {
      activateEngineSession: async () => ({
        payload: { ok: false, error: "no", code: "unsupported" },
        statusHint: 501,
        gate: {},
        transport: "acp",
      }),
    });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleActivateSession(jsonReq({ sessionId: "mvs_x" }), res, {
      cs: mkCs(),
      cid: "tab-1",
    });
    const seen = lastResponse(res);
    assert.equal(seen.status, 501);
    assert.equal(seen.body, '{"ok":false,"error":"no","code":"unsupported"}');
  });

  test("PROOF: a marker error from the activate facade escapes the route", async (t) => {
    await setupMocks(t, {});
    const marker = new Error("B7-ACTIVATE-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
      activateEngineSession: async () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleActivateSession(jsonReq({ sessionId: "mvs_x" }), mkRes(), {
        cs: mkCs(),
        cid: "tab-1",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });
});
