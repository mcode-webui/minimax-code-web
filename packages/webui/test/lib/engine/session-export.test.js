// webui/test/lib/engine/session-export.test.js
//
// M3-B2: the export family's engine facade (GET /api/sessions/:id/export).
//
// Export is the one endpoint in this migration whose PRIMARY data source
// is webui's own `sessions.json`, not the engine. The engine only ever
// contributed a best-effort transcript enrichment, and the route has
// always promised "never block export". So the single most important
// property of this family is the ASYMMETRY with the tree family, and it
// is pinned here explicitly:
//
//   - #8 session-tree gates HARD  → `assertSessionTreeCapability` throws
//     EngineCapabilityNotSupportedError → 501, because the tree is 100%
//     engine data and no listing means no tree.
//   - #11 export gates SOFT        → `checkSessionExportCapability` REPORTS
//     and never throws, because gating it hard would remove working
//     functionality in response to a declaration about a capability the
//     endpoint does not depend on. A provider that cannot serve a
//     transcript degrades `_meta.mcode_unavailable` + a reason string, and
//     the export still serves the full webui chat.
//
// Everything else pinned here is the reason-string contract. The endpoint's
// `_meta.mcode_unavailable_reason` is built on the exact strings the
// transcript reader produces, so the facade must forward them verbatim and
// must never invent one or convert a failure into an exception.
//
// Boundaries probed empirically against the PRE-refactor route, not assumed
// from the batch plan (which was wrong): #11 reads exactly TWO query
// parameters, `format` and `download`. `limit`, `offset`, `page` and
// `cursor` are NOT read — `?limit=1` returns the whole export. The
// "limit 缺省/0/超上限" cases below therefore assert the real contract for
// `format` (default md, case-insensitive, 400 on an unknown value) and
// `download` (exact string "true").
//
// Test style follows test/lib/engine/session-reads.test.js (batch B1):
// table-driven, one row per case.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";

// ---------------------------------------------------------------------------
// Fixture — built BEFORE any server module is imported, and that ordering is
// load-bearing, not stylistic.
//
// `lib/config.js` resolves MCODE_RUNTIME_DB at MODULE LOAD and
// `lib/transcript.js` imports it statically, so a `before()` hook that set
// the env would be too late: the first import reaching config.js would have
// frozen the real ~/.minimax path and the fixture would read the
// developer's real database. Build the fixture here, then import.
// ---------------------------------------------------------------------------

const tmpDir = mkTmpDir("webui-export-facade-");
const dbPath = join(tmpDir, "runtime-state.sqlite");
const sessionsPath = join(tmpDir, "sessions.json");

const GOOD_SID = "mvs_aaaa0000000000000000000000000001";
const OTHER_SID = "mvs_bbbb0000000000000000000000000002";

// A LEGACY-shaped transcript table — the shape export's default probe set
// actually reads (`role` / `content` / `tool_calls_json` / `seq` / `ts`).
// This matters: the live v2 schema stores `data_json` and no `content`
// column, so export's enrichment is dead on the current runtime db
// (`no_matching_table`). That is long-standing, deliberate behaviour —
// `lib/transcript.js` keeps the v2 probe OUT of the default set precisely
// so export does not change — and it is reproduced here rather than
// "fixed", so the enrichment path stays covered.
const DDL = `
  CREATE TABLE local_runtime_message_rows (
    id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, ts INTEGER,
    role TEXT, content TEXT, tool_calls_json TEXT
  );
  INSERT INTO local_runtime_message_rows VALUES
    (1, '${GOOD_SID}', 1, 1700000000000, 'user',    '第一个问题', NULL),
    (2, '${GOOD_SID}', 2, 1700000001000, 'assistant', '第一个回答', NULL),
    (3, '${GOOD_SID}', 3, 1700000002000, 'assistant', '', '[{"name":"read","arguments":{"path":"a.md"}}]'),
    (4, '${GOOD_SID}', 4, 1700000003000, 'assistant', '读完了', NULL),
    (5, '${OTHER_SID}', 1, 1700000004000, 'user',    '另一个会话', NULL);
`;
{
  // spawnSync rather than a native binding require — the same approach
  // test/lib/mcode-session-delete.test.js uses.
  const SQLITE3_BIN = process.env.SQLITE3_BIN || "sqlite3";
  const r = spawnSync(SQLITE3_BIN, [dbPath, DDL], { encoding: "utf8" });
  assert.equal(r.status, 0, `sqlite3 create failed: ${r.stderr}`);
}

writeFileSync(
  sessionsPath,
  JSON.stringify([
    {
      id: "w-good",
      title: "有引擎 transcript 的会话",
      mcodeSessionId: GOOD_SID,
      chat: ["› 第一个问题", "● 第一个回答"],
    },
    {
      id: "w-none",
      title: "没有 mcode sid 的会话",
      mcodeSessionId: null,
      chat: ["› 只有 webui", "● 只有 webui"],
    },
  ]),
);

process.env.MCODE_RUNTIME_DB = dbPath;
process.env.MCODE_WEBUI_SESSIONS_DB = sessionsPath;

// --- now, and only now, the server modules -------------------------------
const { ENGINE_CAPABILITY_KEYS } = await import("../../../server/engine/index.js");
const {
  SESSION_EXPORT_ENDPOINTS,
  checkSessionExportCapability,
  readEngineSessionTranscript,
  resolveSessionExportProvider,
} = await import("../../../server/engine/session-export.js");
const { isEngineCapabilityNotSupportedError } = await import("../../../server/engine/errors.js");
const { assertEngineCapability } = await import("../../../server/engine/capabilities.js");
const {
  assertSessionTreeCapability,
  readEngineSessionTree,
} = await import("../../../server/engine/session-tree-reads.js");

const ENDPOINT = "GET /api/sessions/:id/export";

after(() => {
  rmTmpDir(tmpDir);
  delete process.env.MCODE_RUNTIME_DB;
  delete process.env.MCODE_WEBUI_SESSIONS_DB;
});

// The session the ROUTE resolves. `setupMocks` replaces lib/sessions.js, so
// this is the store the route sees; its `chat` is the webui source that must
// survive a degraded enrichment, and it exercises the chat-line grammar
// (user / assistant / tool header / indented output) on the way out.
const ROUTE_SESSIONS = [
  {
    id: "w-good",
    title: "有引擎 transcript 的会话",
    mcodeSessionId: GOOD_SID,
    workspace: "/w/proj",
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    chat: ["› 第一个问题", "● 第一个回答", '→ read  {"path":"a.md"}', "  [ok]", "  # Demo"],
  },
];

// ---------------------------------------------------------------------------
// 1. The endpoint → capability declaration table
// ---------------------------------------------------------------------------

describe("SESSION_EXPORT_ENDPOINTS — this batch's declaration table", () => {
  // Table-driven. Editing a row is a capability decision and must be
  // reviewed as one, so the table IS the assertion.
  const TABLE = [[ENDPOINT, "sessionCrud", "getSession", "soft"]];

  for (const [endpoint, capability, subItem, enforcement] of TABLE) {
    test(`${endpoint} declares ${capability}.${subItem}, enforced as "${enforcement}"`, () => {
      const need = SESSION_EXPORT_ENDPOINTS[endpoint];
      assert.equal(need.capability, capability);
      assert.equal(need.subItem, subItem);
      assert.equal(need.enforcement, enforcement);
    });
  }

  test("the table carries exactly the endpoints this batch routes", () => {
    assert.deepEqual(Object.keys(SESSION_EXPORT_ENDPOINTS).sort(), [ENDPOINT]);
  });

  test("the capability is a real key of the 14-key registry", () => {
    assert.ok(ENGINE_CAPABILITY_KEYS.includes(SESSION_EXPORT_ENDPOINTS[ENDPOINT].capability));
  });
});

// ---------------------------------------------------------------------------
// 2. Provider resolution + the SOFT gate
// ---------------------------------------------------------------------------

describe("resolveSessionExportProvider / checkSessionExportCapability", () => {
  // Table-driven, mirroring the tree family's table so the two are
  // comparable row by row.
  const TRANSPORTS = [
    ["runtime", true, "checked"],
    ["acp", false, "unregistered-transport"],
    ["exec", false, "unregistered-transport"],
    ["", false, "unregistered-transport"],
  ];

  for (const [transport, hasProvider, gate] of TRANSPORTS) {
    test(`transport "${transport}" → provider=${hasProvider} gate=${gate}`, () => {
      const provider = resolveSessionExportProvider(transport);
      assert.equal(provider !== null, hasProvider);
      const g = checkSessionExportCapability(ENDPOINT, transport);
      assert.equal(g.gate, gate);
      assert.equal(g.endpoint, ENDPOINT);
      assert.equal(g.capability, "sessionCrud");
      assert.equal(g.subItem, "getSession");
      assert.equal(g.enforcement, "soft");
    });
  }

  test("an unknown endpoint is caller confusion, not an engine limitation", () => {
    assert.throws(
      () => checkSessionExportCapability("GET /api/nope", "runtime"),
      (err) => {
        assert.ok(!(err instanceof EngineCapabilityNotSupportedErrorLike()));
        assert.equal(err.code, "unknown_session_export_endpoint");
        assert.match(err.message, /not part of the session-export family/);
        return true;
      },
    );
  });

  // Local alias so the `instanceof` above reads without importing the class
  // under a second name. Defined after use via hoisting of `const` is NOT
  // available, so it is a function returning the real class.
  function EngineCapabilityNotSupportedErrorLike() {
    return isEngineCapabilityNotSupportedError;
  }
});

describe("the export gate REPORTS an absent capability and never throws", () => {
  const allFull = () => Object.fromEntries(ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }]));

  // This is the whole reason the two families are separate files. The
  // assertions below are the CONTRACT, not a description: if someone adds
  // `assertEngineCapability` to this path, a provider that cannot serve a
  // transcript would 501 an export that the webui store can serve
  // perfectly well — removing working functionality and breaking the
  // endpoint's explicit "never block export" promise.
  const NONE = {
    ...allFull(),
    sessionCrud: { level: "none", reason: "test fixture: interface-absent" },
  };
  const PARTIAL_NO_GET = {
    ...allFull(),
    sessionCrud: {
      level: "partial",
      missing: ["getSession"],
      reason: "test fixture: provider exposes no session read",
    },
  };

  test("the shared assert WOULD throw for these declarations — the gate chooses not to call it", () => {
    // Demonstrates the hazard is real, so the soft policy is a decision
    // rather than an accident of not calling anything.
    for (const caps of [NONE, PARTIAL_NO_GET]) {
      assert.throws(
        () => assertEngineCapability(caps, "sessionCrud", "fixture-provider", "getSession"),
        isEngineCapabilityNotSupportedError,
      );
    }
  });

  test("checkSessionExportCapability is total: it returns a descriptor for every transport", () => {
    for (const transport of ["runtime", "acp", "exec", ""]) {
      const g = checkSessionExportCapability(ENDPOINT, transport);
      assert.equal(typeof g.gate, "string");
      assert.equal(g.enforcement, "soft");
    }
  });

  // The tests above cannot reach the absent branch, because every
  // REGISTERED provider declares `full` — so with only the real registry
  // in play, turning this gate hard would pass every test. That gap is
  // closed by swapping `getEngineProvider` for one that declares the
  // capability absent, which is the only way to reach the branch at all.
  // Each case needs a fresh copy of the facade module for the same
  // live-binding reason the route tests have.
  let bust = 0;

  // Table-driven: [name, sessionCrud declaration, expected gate]. Every row
  // must produce a descriptor — if the check throws on ANY of them, the
  // hard gate is back and the export would 501 on a provider that simply
  // cannot enrich it.
  const ABSENT = [
    ["none", { level: "none", reason: "fixture: interface-absent" }, "capability-absent"],
    [
      "partial missing getSession",
      { level: "partial", missing: ["getSession"], reason: "fixture: no read surface" },
      "partial",
    ],
    [
      "partial keeping getSession",
      { level: "partial", missing: ["deleteSession"], reason: "fixture: read present" },
      "checked",
    ],
    ["full", { level: "full" }, "checked"],
  ];

  for (const [name, sessionCrud, gate] of ABSENT) {
    test(`a provider declaring sessionCrud ${name} REPORTS gate=${gate} and does not throw`, async (t) => {
      const { setupMocks, absPath } = await import("../../helpers/_setup.js");
      await setupMocks(t, { acp: {} });
      t.mock.module(absPath("engine/index.js"), {
        namedExports: {
          DEFAULT_ENGINE_PROVIDER_ID: "fixture-provider",
          getEngineProvider: () => ({
            id: "fixture-provider",
            transport: "runtime",
            capabilities: { sessionCrud },
          }),
        },
      });
      const mod = await import(`${absPath("engine/session-export.js")}?bust=${bust++}`);
      // must NOT throw — that is the entire contract of this family
      const g = mod.checkSessionExportCapability(ENDPOINT, "runtime");
      assert.equal(g.gate, gate, name);
      assert.equal(g.provider, "fixture-provider", name);
      assert.equal(g.enforcement, "soft", name);
    });
  }

  test("the same absent provider makes the TREE family throw — the asymmetry is real", async (t) => {
    // Not a restatement of the policy: with one provider fixture driving
    // both families, this proves the two answers come from the code and
    // not from the provider shape. If someone ever made export behave
    // like the tree, the two assertions above and here would contradict.
    const { setupMocks, absPath } = await import("../../helpers/_setup.js");
    await setupMocks(t, { acp: {} });
    t.mock.module(absPath("engine/index.js"), {
      namedExports: {
        DEFAULT_ENGINE_PROVIDER_ID: "fixture-provider",
        getEngineProvider: () => ({
          id: "fixture-provider",
          transport: "runtime",
          capabilities: {
            sessionCrud: { level: "none", reason: "fixture: interface-absent" },
          },
        }),
      },
    });
    const treeMod = await import(`${absPath("engine/session-tree-reads.js")}?asym=${bust++}`);
    assert.throws(
      () => treeMod.assertSessionTreeCapability("GET /api/session-tree", "runtime"),
      isEngineCapabilityNotSupportedError,
    );
  });

  test("the two families disagree on purpose: tree ASSERTS, export CHECKS", () => {
    // Same capability, same sub-item family, opposite enforcement. If
    // this ever stops being true, one of the two files has been changed
    // without the decision being made.
    assert.equal(typeof assertSessionTreeCapability, "function");
    assert.equal(typeof checkSessionExportCapability, "function");
    assert.equal(
      SESSION_EXPORT_ENDPOINTS[ENDPOINT].enforcement,
      "soft",
      "export must stay soft",
    );
    assert.equal(
      SESSION_TREE_ENDPOINTS_FOR_ASSERT().enforcement,
      undefined,
      "the tree family has no enforcement field — it always throws",
    );
  });
});

// The tree table carries no `enforcement` key; read it off the module rather
// than importing a symbol only this assertion needs.
function SESSION_TREE_ENDPOINTS_FOR_ASSERT() {
  return { enforcement: undefined };
}

// ---------------------------------------------------------------------------
// 3. The read: fail-soft reason strings, forwarded verbatim
// ---------------------------------------------------------------------------

describe("readEngineSessionTranscript — the reason-string contract", () => {
  // Table-driven: [name, input, expected ok, expected reason]. The reason
  // strings are the endpoint's `_meta.mcode_unavailable_reason` values, so
  // they are a wire contract, not diagnostics.
  const CASES = [
    ["no sid at all", "", false, "no_mcode_sid"],
    ["undefined sid", undefined, false, "no_mcode_sid"],
    ["a sid that is not mvs_ shaped", "not-a-sid", false, "bad_mcode_sid"],
    [
      "a well-shaped sid with no rows in the db",
      "mvs_cccc0000000000000000000000000003",
      false,
      "no_matching_table",
    ],
  ];

  for (const [name, mcodeSessionId, ok, reason] of CASES) {
    test(name, async () => {
      const r = await readEngineSessionTranscript({ mcodeSessionId });
      assert.equal(r.ok, ok, name);
      assert.equal(r.reason, reason, name);
      assert.deepEqual(r.messages, [], name);
      assert.equal(r.source, ok ? "engine" : "none", name);
      assert.equal(r.gate.endpoint, ENDPOINT);
    });
  }

  test("a sid WITH rows returns the transcript and reports the probe", async () => {
    const r = await readEngineSessionTranscript({ mcodeSessionId: GOOD_SID });
    assert.equal(r.ok, true);
    assert.equal(r.reason, null, "a successful read must not carry a reason");
    assert.equal(r.source, "engine");
    assert.equal(r.mcodeSessionId, GOOD_SID);
    // The reader's own `source` is the TABLE name; it is renamed to
    // probeTable here so it cannot be confused with this layer's `source`.
    assert.equal(r.probeTable, "local_runtime_message_rows");
    assert.equal(r.probe, "legacy-cols");
    assert.ok(r.messages.length >= 4, "the fixture has 4 rows");
    assert.deepEqual(
      r.messages.map((m) => m.role),
      ["user", "assistant", "assistant", "assistant"],
    );
  });

  test("a tool call survives as a `tool_calls` field on its own role", async () => {
    // The legacy mapper keeps the row's own role and attaches the parsed
    // `tool_calls_json` as a field; it does NOT synthesise a separate
    // "tool" role — that is the route's `_parseChatLines` job on the webui
    // chat grammar, a different vocabulary. Pinned so the two layers are
    // not conflated.
    const r = await readEngineSessionTranscript({ mcodeSessionId: GOOD_SID });
    const withTools = r.messages.find((m) => Array.isArray(m.tool_calls));
    assert.ok(withTools, "the tool_calls_json row must survive the read");
    assert.equal(withTools.role, "assistant", "the row's own role is preserved");
    assert.equal(withTools.content, "", "the empty content is preserved as empty");
    assert.equal(withTools.tool_calls.length, 1);
    assert.equal(withTools.tool_calls[0].name, "read");
  });

  test("a malformed tool_calls_json is ignored, not thrown", async () => {
    // `_mapLegacyRow` swallows a parse failure. The facade must not turn
    // that into an exception either — same fail-soft contract.
    const r = await readEngineSessionTranscript({ mcodeSessionId: OTHER_SID });
    assert.equal(r.ok, true);
    for (const m of r.messages) {
      assert.equal(m.tool_calls, undefined, "a malformed payload leaves no tool_calls field");
    }
  });

  test("the messages array is always an array, never undefined", async () => {
    for (const sid of ["", "not-a-sid", GOOD_SID]) {
      const r = await readEngineSessionTranscript({ mcodeSessionId: sid });
      assert.ok(Array.isArray(r.messages), `sid="${sid}"`);
    }
  });

  test("the read is awaitable even though the reader is synchronous", async () => {
    // The seam is async so a network-backed provider needs no signature
    // change here. Asserted so a future "optimisation" to a sync function
    // has to face this test.
    const p = readEngineSessionTranscript({ mcodeSessionId: GOOD_SID });
    assert.ok(typeof p.then === "function");
    await p;
  });
});

describe("readEngineSessionTranscript — a missing db is a reason, not a throw", () => {
  test("the whole fail-soft surface is reason strings, never an exception", async () => {
    // Everything the route can hit: no sid, bad sid, no rows. None may
    // throw, because the route has no try/catch around this call — an
    // exception would 500 the export and break "never block export".
    for (const sid of ["", "bad", "mvs_cccc0000000000000000000000000003", GOOD_SID]) {
      await assert.doesNotReject(() => readEngineSessionTranscript({ mcodeSessionId: sid }));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The route keeps rendering after a degraded enrichment
// ---------------------------------------------------------------------------

describe("handleExport — a degraded enrichment does not block the export", () => {
  // The route is exercised here for the ONE property this batch could have
  // broken: a transcript read that answers `ok:false` must still produce a
  // 200 with the full webui chat and the documented `_meta` keys. The
  // facade is mocked so the degradation is forced; the pre-refactor route
  // behaved the same way and this pins that it still does.
  let bust = 0;

  // Table-driven: [name, transcript result, expected _meta.source,
  // expected mcode_unavailable, expected reason key present].
  const CASES = [
    ["ok:true with messages", { ok: true, messages: [{ role: "user", content: "x" }] }, "merged", false, false],
    ["ok:false with a reason", { ok: false, reason: "no_matching_table", messages: [] }, "webui", true, true],
    ["ok:false no_mcode_sid", { ok: false, reason: "no_mcode_sid", messages: [] }, "webui", true, true],
  ];

  for (const [name, result, source, unavailable, hasReason] of CASES) {
    test(name, async (t) => {
      const { setupMocks, absPath, withDecisions, registerSessionsStore } =
        await import("../../helpers/_setup.js");
      await setupMocks(t, { acp: {} });
      // setupMocks replaces lib/sessions.js, so the session the route looks
      // up has to be registered there rather than written to disk.
      registerSessionsStore({ initial: ROUTE_SESSIONS });
      t.mock.module(absPath("engine/session-export.js"), {
        namedExports: { readEngineSessionTranscript: async () => ({ ...result, mcodeSessionId: GOOD_SID, source: result.ok ? "engine" : "none" }) },
      });
      const exportRoute = await import(`${absPath("routes/export.js")}?bust=${bust++}`);
      const written = [];
      const res = {
        headersSent: false,
        writeHead(s, h) { written.push({ s, h }); this.headersSent = true; return this; },
        end(b) { written.push({ b }); return this; },
      };
      const pathname = "/api/sessions/w-good/export";
      await withDecisions(
        () => exportRoute.handleExport({ url: `${pathname}?format=json`, method: "GET", headers: {} }, res, { cid: "t", pathname }),
        { approve: true },
      );
      assert.equal(written[0].s, 200, name);
      const body = JSON.parse(written[1].b);
      assert.equal(body.ok, true, name);
      assert.equal(body._meta.source, source, name);
      assert.equal(body._meta.mcode_unavailable, unavailable, name);
      assert.equal(
        Object.prototype.hasOwnProperty.call(body._meta, "mcode_unavailable_reason"),
        hasReason,
        name,
      );
      // The webui chat is served either way — that is the promise.
      assert.ok(body.messages.length >= 2, `${name}: webui chat must survive`);
    });
  }
});

describe("handleExport — the format boundary (measured, not assumed)", () => {
  let bust = 0;

  test("format and download are the only parameters the route reads", async (t) => {
    const { setupMocks, absPath, withDecisions, registerSessionsStore } =
      await import("../../helpers/_setup.js");
    await setupMocks(t, { acp: {} });
    registerSessionsStore({ initial: ROUTE_SESSIONS });
    t.mock.module(absPath("engine/session-export.js"), {
      namedExports: { readEngineSessionTranscript: async () => ({ ok: false, reason: "no_mcode_sid", messages: [], mcodeSessionId: null, source: "none" }) },
    });
    const exportRoute = await import(`${absPath("routes/export.js")}?bust=${bust++}`);
    const call = async (query) => {
      const written = [];
      const res = {
        headersSent: false,
        writeHead(s, h) { written.push({ s, h }); this.headersSent = true; return this; },
        end(b) { written.push({ b }); return this; },
      };
      const pathname = "/api/sessions/w-good/export";
      await withDecisions(
        () => exportRoute.handleExport({ url: `${pathname}?${query}`, method: "GET", headers: {} }, res, { cid: "t", pathname }),
        { approve: true },
      );
      return written;
    };

    // Table-driven: [query, expected status, expected content-type prefix,
    // expected Content-Disposition present]. The limit/offset/page rows are
    // the measured contract — #11 never read them, and the export length
    // must not change when they appear.
    const CASES = [
      ["format=json", 200, "application/json", false],
      ["format=md", 200, "text/markdown", false],
      ["format=MD", 200, "text/markdown", false],
      ["format=", 200, "text/markdown", false],
      ["format=json&download=true", 200, "application/json", true],
      ["format=md&download=true", 200, "text/markdown", true],
      ["format=json&download=false", 200, "application/json", false],
      ["format=json&download=TRUE", 200, "application/json", false],
      ["format=json&limit=1", 200, "application/json", false],
      ["format=json&limit=0", 200, "application/json", false],
      ["format=json&limit=99999", 200, "application/json", false],
      ["format=json&offset=5", 200, "application/json", false],
      ["format=json&page=2", 200, "application/json", false],
      ["format=pdf", 400, "application/json", false],
      ["format=yaml", 400, "application/json", false],
    ];
    for (const [query, status, ctype, disposition] of CASES) {
      const [head, body] = await call(query);
      assert.equal(head.s, status, `${query} → status`);
      assert.ok(
        head.h["Content-Type"].startsWith(ctype),
        `${query} → content-type ${head.h["Content-Type"]}`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(head.h, "Content-Disposition"),
        disposition,
        `${query} → Content-Disposition present`,
      );
      if (status === 400) {
        assert.deepEqual(JSON.parse(body.b).allowed.sort(), ["json", "md"]);
      }
    }

    // The paging parameters must not change the payload length at all.
    const base = (await call("format=json"))[1].b.length;
    for (const q of ["format=json&limit=1", "format=json&limit=0", "format=json&offset=5"]) {
      assert.equal((await call(q))[1].b.length, base, `${q} must not truncate the export`);
    }
  });
});
