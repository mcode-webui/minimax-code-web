// webui/test/lib/engine/session-reads.test.js
//
// M3-B1: the directory-read family's engine facade.
//
// Two things are pinned here, and they are the two ways this batch could
// have gone wrong:
//
//   1. The WIRE SHAPE of the five endpoints (#9, #10, #72, #74, #75) is
//      a frontend contract. The sidebar tree and the /api/state first
//      frame both render from it, so a field added "just in case", a
//      `null` quietly turned into `[]`, or a reordered object all look
//      harmless in a diff and all break a render. The shape tables below
//      are the regression net for that, table-driven per the repo's
//      convention so a new case is one row, not one test.
//
//   2. The GATE is real, not decorative. A provider that declares
//      `sessionCrud: none` must produce EngineCapabilityNotSupportedError
//      → 501 through app.js#invokeHandler, never an empty list. That is
//      the whole point of routing reads through a declaration instead of
//      through whatever transport happens to be configured, and the
//      registered provider declares `full` today, so only this file can
//      prove the gate would bite.
//
// Test style follows test/lib/engine/capabilities.test.js (batch B1).
// Where a route handler is exercised it goes through the same
// setupMocks/registerAcpMock infrastructure the other route suites use.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_CAPABILITY_KEYS,
  LOCAL_RUNTIME_V2_CAPABILITIES,
} from "../../../server/engine/index.js";
import {
  EngineCapabilityNotSupportedError,
  isEngineCapabilityNotSupportedError,
  engineCapabilityHttpResponse,
} from "../../../server/engine/errors.js";
import {
  SESSION_READ_ENDPOINTS,
  assertSessionReadCapability,
  readEngineSessionList,
  readEngineSessionListForWorkspace,
  readEngineSessionTitle,
  readEngineVersion,
  resolveSessionReadProvider,
} from "../../../server/engine/session-reads.js";
import {
  assertEngineCapability,
  validateEngineCapabilities,
} from "../../../server/engine/capabilities.js";

// ---------------------------------------------------------------------------
// The endpoint → capability declaration table
// ---------------------------------------------------------------------------

describe("SESSION_READ_ENDPOINTS — the batch's declaration table", () => {
  // Table-driven: [endpoint, capability, subItem]. Editing a row here is a
  // capability decision and must be reviewed as one.
  const TABLE = [
    ["GET /api/acp-sessions", "sessionCrud", "listSessions"],
    ["GET /api/acp-session-title", "sessionCrud", "getSession"],
    ["GET /api/protocol/list-sessions", "sessionCrud", "listSessions"],
    ["GET /api/state", "sessionCrud", "listSessions"],
  ];

  test("covers exactly the five endpoints of batch B1", () => {
    assert.deepEqual(Object.keys(SESSION_READ_ENDPOINTS).sort(), [
      "GET /api/acp-session-title",
      "GET /api/acp-sessions",
      "GET /api/health",
      "GET /api/protocol/list-sessions",
      "GET /api/state",
    ]);
  });

  for (const [endpoint, capability, subItem] of TABLE) {
    test(`${endpoint} needs ${capability}.${subItem}`, () => {
      assert.deepEqual(SESSION_READ_ENDPOINTS[endpoint], { capability, subItem });
      // Every named capability must be one of the 14 matrix keys — the
      // table must not grow a private key (that would put an unreviewed
      // capability in the registry, which validateEngineCapabilities
      // exists to prevent).
      assert.ok(ENGINE_CAPABILITY_KEYS.includes(capability));
    });
  }

  test("/api/health declares no capability — the 14 keys have no honest match", () => {
    // Reading the engine's *installed* version is not `updateCheck`
    // (checking for a NEW version). Declaring one anyway would be the
    // "claim a capability that does not exist" failure this batch exists
    // to prevent, so the table says `null` and the facade reports
    // gate: "no-capability-key" instead.
    assert.equal(SESSION_READ_ENDPOINTS["GET /api/health"], null);
  });

  test("the gate is a no-op for a null capability rather than a throw", () => {
    const gate = assertSessionReadCapability("GET /api/health", "runtime");
    assert.equal(gate.gate, "no-capability-key");
    assert.equal(gate.capability, null);
    assert.equal(gate.subItem, null);
  });

  test("an endpoint outside this family throws a plain Error, not 501 material", () => {
    // Caller confusion must never be dressed up as an engine limitation:
    // app.js answers 404-ish for a plain Error and 501 for
    // EngineCapabilityNotSupportedError.
    assert.throws(
      () => assertSessionReadCapability("GET /api/fs/read", "runtime"),
      (err) =>
        !(err instanceof EngineCapabilityNotSupportedError) &&
        err.code === "unknown_session_read_endpoint",
    );
  });
});

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

describe("resolveSessionReadProvider", () => {
  test("runtime maps to the registered local-runtime-v2 provider", () => {
    const provider = resolveSessionReadProvider("runtime");
    assert.equal(provider.id, "local-runtime-v2");
    assert.equal(provider.capabilities, LOCAL_RUNTIME_V2_CAPABILITIES);
  });

  // M4 registers the acp / exec providers. Until then there is no
  // declaration to check under those transports, and the gate says so
  // instead of borrowing the v2 provider's declaration (which would be
  // answering for a provider that is not on the wire).
  for (const transport of ["acp", "exec"]) {
    test(`${transport} has no registered provider yet → null`, () => {
      assert.equal(resolveSessionReadProvider(transport), null);
      const gate = assertSessionReadCapability("GET /api/acp-sessions", transport);
      assert.equal(gate.gate, "unregistered-transport");
      assert.equal(gate.provider, null);
      // Still names what WOULD be needed, so the passthrough is auditable.
      assert.equal(gate.capability, "sessionCrud");
      assert.equal(gate.subItem, "listSessions");
    });
  }
});

// ---------------------------------------------------------------------------
// The gate actually bites
// ---------------------------------------------------------------------------

describe("assertSessionReadCapability — a limited provider answers 501", () => {
  // A hypothetical future provider (M4's ACP provider is the real case):
  // it has the session read surface but no delete/rename. The read family
  // must keep working — that is the point of naming the sub-item rather
  // than the capability alone.
  const PARTIAL_NO_LIST = {
    ...Object.fromEntries(ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }])),
    sessionCrud: {
      level: "partial",
      missing: ["listSessions", "getSession", "deleteSession", "renameSession"],
      reason: "test fixture: provider exposes no session read surface",
    },
  };
  // And a provider with no session support at all.
  const NONE = {
    ...Object.fromEntries(ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }])),
    sessionCrud: { level: "none", reason: "test fixture: interface-absent" },
  };

  // Table-driven over the four gated endpoints: every one of them must
  // refuse under a provider that cannot list, and name the method it
  // needed. A row that silently passes is a route that would answer `[]`.
  const GATED = [
    ["GET /api/acp-sessions", "listSessions"],
    ["GET /api/acp-session-title", "getSession"],
    ["GET /api/protocol/list-sessions", "listSessions"],
    ["GET /api/state", "listSessions"],
  ];

  for (const [endpoint, subItem] of GATED) {
    test(`${endpoint} throws EngineCapabilityNotSupportedError naming ${subItem}`, () => {
      const need = SESSION_READ_ENDPOINTS[endpoint];
      assert.throws(
        () => assertEngineCapability(PARTIAL_NO_LIST, need.capability, "fixture-provider", need.subItem),
        (err) => {
          assert.ok(isEngineCapabilityNotSupportedError(err));
          assert.equal(err.capability, "sessionCrud");
          assert.equal(err.provider, "fixture-provider");
          assert.deepEqual(err.missing, [subItem]);
          // The HTTP mapping is the frontend's contract for degradation.
          const { status, payload } = engineCapabilityHttpResponse(err);
          assert.equal(status, 501);
          assert.equal(payload.code, "engine_capability_not_supported");
          assert.equal(payload.capability, "sessionCrud");
          assert.deepEqual(payload.missing, [subItem]);
          return true;
        },
      );
    });

    test(`${endpoint} throws for a provider that declares sessionCrud: none`, () => {
      const need = SESSION_READ_ENDPOINTS[endpoint];
      assert.throws(
        () => assertEngineCapability(NONE, need.capability, "fixture-provider"),
        isEngineCapabilityNotSupportedError,
      );
    });
  }

  test("a partial declaration that keeps listSessions lets the read family through", () => {
    const PARTIAL_WITH_READ = {
      ...PARTIAL_NO_LIST,
      sessionCrud: {
        level: "partial",
        missing: ["deleteSession", "renameSession"],
        reason: "test fixture: read surface present, write surface absent",
      },
    };
    for (const [endpoint] of GATED) {
      const need = SESSION_READ_ENDPOINTS[endpoint];
      assert.doesNotThrow(() =>
        assertEngineCapability(PARTIAL_WITH_READ, need.capability, "fixture-provider", need.subItem),
      );
    }
  });

  test("the fixtures themselves are valid declarations (the gate is the only difference)", () => {
    assert.deepEqual(validateEngineCapabilities(PARTIAL_NO_LIST), []);
    assert.deepEqual(validateEngineCapabilities(NONE), []);
  });

  test("the registered provider passes every row of the table", () => {
    for (const [endpoint, capability, subItem] of [
      ...GATED.map(([e]) => [e, SESSION_READ_ENDPOINTS[e].capability, SESSION_READ_ENDPOINTS[e].subItem]),
    ]) {
      assert.doesNotThrow(() =>
        assertEngineCapability(LOCAL_RUNTIME_V2_CAPABILITIES, capability, "local-runtime-v2", subItem),
        `${endpoint} must pass against the registered provider today`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The reads, with the acp-client mocked the way routes are tested
// ---------------------------------------------------------------------------

// `t.mock` only exists on the context a TOP-LEVEL hook receives, so the
// registration lives at file scope like every other suite in the repo
// (see test/routes/sessions.check.mjs). The facade reaches the acp-client
// through `await import()` inside its read functions, so a registration
// made here still lands before the first read.
let acpMock;
before(async (t) => {
  const { setupMocks, acpMock: handle } = await import("../../helpers/_setup.js");
  await setupMocks(t, {});
  acpMock = handle;
});

beforeEach(() => {
  acpMock.listAllMcodeSessions = async () => [];
  acpMock.getMcodeSessionsForWorkspace = async () => [];
  acpMock.getMcodeSessionTitle = async () => null;
  acpMock.getMcodeServerInfo = () => null;
  acpMock.getCatalogueHost = async () => null;
});

describe("session-reads — the reads themselves", () => {
  // -------------------------------------------------------------------------
  // #9 / #72 — the sidebar list shape, field by field
  // -------------------------------------------------------------------------

  // One ACP-wire session entry. `title` and `updatedAt` are OPTIONAL on the
  // wire: `catalogue-sessions.js#projectTuiSessionToAcp` omits `title` when
  // empty and `updatedAt` when unparseable, exactly like the ACP adapter's
  // `toAcpSessionInfo`. The facade forwards that projection untouched, so a
  // normalizer that started defaulting either to `null` / `""` would change
  // what the sidebar renders for unnamed sessions.
  const WIRE_SESSION = {
    sessionId: "mvs_aaaa1111222233334444555566667777",
    cwd: "/ws/a",
    title: "Engine generated title",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };

  describe("readEngineSessionList (#72 — all workspaces)", () => {
    // Table-driven: [name, engineAnswer, expectedSource, expectedReason].
    // `transport` here is whatever the process was started with — the
    // suite is run under both by the batch's gate, so the assertion is on
    // the RULE, not on one transport's value.
    const CASES = [
      ["one session, all four wire fields", [WIRE_SESSION], null],
      ["no sessions at all → [] (never null)", [], null],
    ];

    for (const [name, engineAnswer] of CASES) {
      test(name, async () => {
        acpMock.listAllMcodeSessions = async () => engineAnswer;
        const result = await readEngineSessionList();
        assert.deepEqual(result.sessions, engineAnswer);
        assert.ok(Array.isArray(result.sessions), "sessions is always an array");
        assert.equal(result.transport, process.env.MCODE_WEBUI_TRANSPORT || "acp");
        // `source` is metadata, not wire: the route ignores it, the tests
        // and the log read it.
        assert.ok(
          ["catalogue", "acp", "acp-fallback"].includes(result.source),
          `unexpected source ${result.source}`,
        );
        assert.equal(result.gate.endpoint, "GET /api/protocol/list-sessions");
      });
    }

    test("field set of an entry is exactly the ACP wire projection — no more, no less", async () => {
      acpMock.listAllMcodeSessions = async () => [WIRE_SESSION];
      const { sessions } = await readEngineSessionList();
      assert.deepEqual(Object.keys(sessions[0]), ["sessionId", "cwd", "title", "updatedAt"]);
    });

    // null vs [] is the distinction the sidebar actually depends on: an
    // absent list must render "no sessions", a null must not crash the
    // render that maps over it.
    test("an unnamed session keeps `title` ABSENT, not null and not \"\"", async () => {
      const untitled = { sessionId: "mvs_bbbb", cwd: "/ws/b" };
      acpMock.listAllMcodeSessions = async () => [untitled];
      const { sessions } = await readEngineSessionList();
      assert.equal("title" in sessions[0], false, "catalogue-sessions.js omits an empty title");
      assert.equal("updatedAt" in sessions[0], false, "…and an unparseable updatedAt");
      assert.deepEqual(Object.keys(sessions[0]), ["sessionId", "cwd"]);
    });

    test("the facade does not filter by cwd — #72's cwd filter is the route's", async () => {
      acpMock.listAllMcodeSessions = async () => [WIRE_SESSION];
      const { sessions } = await readEngineSessionList();
      assert.equal(sessions.length, 1, "an unfiltered read returns every workspace's sessions");
    });
  });

  describe("readEngineSessionListForWorkspace (#9 / #74 — cwd filtered)", () => {
    const CASES = [
      ["cwd given, engine answers one session", "/ws/a", [WIRE_SESSION]],
      ["cwd empty → no filter, engine answers as-is", "", [WIRE_SESSION]],
      ["no sessions → [] (never null)", "/ws/a", []],
    ];

    for (const [name, cwd, engineAnswer] of CASES) {
      test(name, async () => {
        acpMock.getMcodeSessionsForWorkspace = async () => engineAnswer;
        const result = await readEngineSessionListForWorkspace({ cwd });
        assert.deepEqual(result.sessions, engineAnswer);
        assert.equal(result.gate.endpoint, "GET /api/acp-sessions");
      });
    }

    test("the endpoint key is honoured, so /api/state is gated under its own name", async () => {
      const result = await readEngineSessionListForWorkspace({
        cwd: "/ws/a",
        endpoint: "GET /api/state",
      });
      assert.equal(result.gate.endpoint, "GET /api/state");
    });

    test("an undefined cwd is normalised to \"\" before it reaches the client", async () => {
      const seen = [];
      acpMock.getMcodeSessionsForWorkspace = async (ws) => {
        seen.push(ws);
        return [];
      };
      await readEngineSessionListForWorkspace({});
      assert.deepEqual(seen, [""], "the facade never forwards undefined");
    });
  });

  // -------------------------------------------------------------------------
  // #10 — the title
  // -------------------------------------------------------------------------

  describe("readEngineSessionTitle (#10)", () => {
    // Table-driven on the VALUE. The bridge is a pass-through: it reports
    // exactly what the engine answered and does not decide what "no title"
    // means. Collapsing `""` / undefined to `null` is `handleAcpSessionTitle`'s
    // `title || null`, pinned in test/routes/session-reads.check.mjs — if the
    // bridge started normalising too, one of the two layers would own a rule
    // the other also owns, and an "improvement" to one would silently change
    // the wire.
    const CASES = [
      ["a titled session answers the title verbatim", "mvs_1", "My Title", "My Title"],
      ["an untitled session passes null through", "mvs_2", null, null],
      ["an empty title passes \"\" through (the route collapses it)", "mvs_3", "", ""],
      ["an undefined title passes through undefined", "mvs_4", undefined, undefined],
    ];

    for (const [name, sessionId, engineAnswer, expected] of CASES) {
      test(name, async () => {
        acpMock.getMcodeSessionTitle = async () => engineAnswer;
        const result = await readEngineSessionTitle({ sessionId });
        assert.equal(result.sessionId, sessionId);
        assert.equal(result.title, expected);
        assert.equal(result.gate.endpoint, "GET /api/acp-session-title");
      });
    }

    test("a missing sessionId never reaches the client", async () => {
      let called = 0;
      acpMock.getMcodeSessionTitle = async () => {
        called++;
        return "should not happen";
      };
      const result = await readEngineSessionTitle({ sessionId: "" });
      assert.equal(result.title, null);
      assert.equal(called, 0, "an empty id is answered locally, not by a lookup");
    });
  });

  // -------------------------------------------------------------------------
  // #75 — the version
  // -------------------------------------------------------------------------

  describe("readEngineVersion (#75)", () => {
    // Table-driven: [name, agentInfo, expectedVersion]. `unknown` is the
    // documented sentinel for "nothing has attached yet" and must stay a
    // string — /api/protocol/capabilities uses the same value for the same
    // fact, and a monitor semver-parsing the field would throw on null.
    const CASES = [
      ["an attached client answers its version", { name: "mcode", version: "0.5.7" }, "0.5.7"],
      ["a client without a version answers unknown", { name: "mcode" }, "unknown"],
      ["no client at all answers unknown", null, "unknown"],
    ];

    for (const [name, info, expected] of CASES) {
      test(name, async () => {
        acpMock.getMcodeServerInfo = () => info;
        const result = await readEngineVersion();
        assert.equal(result.version, expected);
        assert.equal(typeof result.version, "string");
        // The version is a protocol fact. The catalogue host exposes no
        // version accessor, so the facade reports the mirror it used
        // rather than claiming the engine answered.
        assert.equal(result.source, "acp");
        assert.equal(result.gate.gate, "no-capability-key");
      });
    }
  });

  // -------------------------------------------------------------------------
  // host === null — the degradation this batch must not hide
  // -------------------------------------------------------------------------

  describe("catalogue host returned null", () => {
    test("a null host is reported as a fallback, never as the engine answering", async () => {
      acpMock.getCatalogueHost = async () => null;
      acpMock.listAllMcodeSessions = async () => [WIRE_SESSION];
      const result = await readEngineSessionList();
      if (result.transport === "runtime") {
        // The transport ASKED for the host and did not get one. The read
        // still succeeds from the ACP mirror (the sidebar must not break),
        // but the source says so — silently claiming "catalogue" here is
        // the fake-success shape.
        assert.equal(result.source, "acp-fallback");
      } else {
        assert.equal(result.source, "acp");
      }
      // Either way the sessions still come back: a read family answers.
      assert.deepEqual(result.sessions, [WIRE_SESSION]);
    });

    test("a live host is reported as catalogue under the runtime transport", async () => {
      acpMock.getCatalogueHost = async () => ({ adapter: {} });
      acpMock.getMcodeSessionsForWorkspace = async () => [WIRE_SESSION];
      const result = await readEngineSessionListForWorkspace({ cwd: "/ws/a" });
      assert.equal(
        result.source,
        result.transport === "runtime" ? "catalogue" : "acp",
        "the source must follow the transport, not a fixed string",
      );
    });

    test("a host that boots but whose list throws still surfaces the throw", async () => {
      acpMock.getCatalogueHost = async () => ({ adapter: {} });
      acpMock.listAllMcodeSessions = async () => {
        throw new Error("sqlite locked");
      };
      // The facade does not swallow a broken engine into an empty list —
      // that is the #110 fake-success shape. acp-client.js owns the
      // ACP failover; the facade adds no second, quieter one.
      await assert.rejects(() => readEngineSessionList(), /sqlite locked/);
    });
  });
});
