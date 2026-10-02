// webui/test/lib/engine/session-switch.test.js
//
// M3-B6: the session SWITCH family's engine facade — #3
// POST /api/sessions/switch.
//
// Sections are ordered by how much user-visible damage a regression in
// each one does, not by which module the function came from:
//
//   1. THE DECLARATION AND ITS SOFT-GATE POLICY. The most consequential
//      judgement call in this batch: #3 gates SOFT because the switch's
//      primary data is webui's own session record and both of its engine
//      touches have a defined degradation. A hard gate would delete a
//      working endpoint over an enrichment. Section 1 proves the gate
//      reports and never throws — including on the DEFAULT `acp`
//      transport, where no provider is registered at all.
//   2. THE FOUR RED LINES. 转录回填 (backfill), cumulative detection,
//      workspace containment, single base-session identity. One named
//      test per line, plus the negative half of each, because a red line
//      that is only asserted in its happy direction is a red line nobody
//      is watching.
//   3. THE BYTE-FOR-BYTE WIRE SHAPES, table-driven across all four
//      outcomes: status, Content-Type, the exact body string and the key
//      ORDER of the success payload.
//   4. THE PURE DERIVATIONS, on their inputs.
//   5. THE ROUTE, with the proof that the facade mock actually took.
//   6. THE TRANSCRIPT SEAM, and what this batch did and did not retire
//      about the 3-candidate probe (KNOWN DEBT 1 in the module header).
//
// Two module-mock traps apply here exactly as they did in B3/B4/B5, and
// both are load-bearing rather than incidental:
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
//      carries a fresh `?bust=N`, and section 5 ends with marker controls
//      that prove it.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import {
  setupMocks,
  absPath,
  registerSessionsStore,
  getSessionsStore,
  registerAcpMock,
} from "../../helpers/_setup.js";
import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";
// Type discrimination goes through the exported predicate, never
// `err.name`. `engine/capabilities.js` is never `mock.module`d by this
// file, so the `instanceof` inside it resolves against the same class
// `checkSessionSwitchCapability` would have thrown from had it thrown at
// all. The string comparison it replaces could not tell a capability
// error from any other error that happened to carry a name.
const { isEngineCapabilityNotSupportedError } = await import(
  "../../../server/engine/errors.js"
);

const RUNTIME = "runtime";
const ACP = "acp";

/** A syntactically valid engine sid — 32 lowercase hex digits. */
const SID_A = "mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SID_B = "mvs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** Not an engine sid: too short. Must take the 404 branch. */
const NOT_A_SID = "webui-does-not-exist";

let bust = 0;

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

/** The v2 probe SQL, read from the ONE declaration (never re-typed). */
let _v2Sql;
async function v2ProbeSql() {
  if (_v2Sql) return _v2Sql;
  const mod = await import(absPath("lib/transcript.js"));
  _v2Sql = mod.V2_DATA_JSON_PROBES[0].sql;
  return _v2Sql;
}

/**
 * Fake better-sqlite3 keyed by SQL string. `prepare()` throws for any SQL
 * the fixture does not carry, exactly as a real prepare does on a missing
 * column — which is what makes the legacy 3-candidate probes "miss" the
 * way they miss against the live v2 schema.
 */
function makeFakeDb({ rowsBySql = {}, constructThrows = false } = {}) {
  return class FakeDb {
    constructor(path, opts) {
      if (constructThrows) throw new Error("fake better-sqlite3: boom");
      this.path = path;
      this.opts = opts;
    }
    prepare(sql) {
      const bySid = rowsBySql[sql];
      if (!bySid) throw new Error(`fake db: no such column (${sql.slice(0, 52)}…)`);
      return { all: (sid) => (bySid[sid] || []).slice() };
    }
    close() {}
  };
}

// Workspace fixtures. `assertWorkspacePath` is NOT mocked anywhere in
// this file — the containment red line is exactly the real gate's
// behaviour, so the fixtures are real directories under a real
// allowed-roots tree, and every path is realpath'd once at setup so the
// assertions compare against the same form the gate normalises to (Linux
// /tmp vs macOS /private/tmp — see fs-write.test.js, #81).
let WS_ROOT, WS_A, WS_B, WS_DEFAULT, WS_OUTSIDE, DEFAULT_DIR, DB_PATH;
let _eventsDir;
// Mutable sqlite fixture, read at call time by the resolver mock
// registered in `before()`. See `bootFacade` for why it cannot be a
// per-test registration.
let _dbOpts = {};

before((t) => {
  _eventsDir = mkTmpDir("webui-switch-facade-events-");
  WS_ROOT = mkTmpDir("webui-switch-facade-roots-");
  DB_PATH = mkTmpDir("webui-switch-facade-db-");
  // Pinned BEFORE any SUT import: `lib/config.js` freezes
  // MCODE_RUNTIME_DB, DEFAULT_WORKSPACE and the audit path at module load.
  process.env.MCODE_WEBUI_EVENTS_PATH = join(_eventsDir, "events.ndjson");
  process.env.MCODE_RUNTIME_DB = join(DB_PATH, "runtime-state.sqlite");
  writeFileSync(process.env.MCODE_RUNTIME_DB, "");
  for (const name of ["projectA", "projectB", "default-workspace"]) {
    mkdirSync(join(WS_ROOT, name), { recursive: true });
  }
  WS_A = realpathSync(join(WS_ROOT, "projectA"));
  WS_B = realpathSync(join(WS_ROOT, "projectB"));
  WS_DEFAULT = realpathSync(join(WS_ROOT, "default-workspace"));
  // A real directory that is deliberately OUTSIDE the allowed roots, so
  // a record pointing at it is refused rather than silently accepted.
  WS_OUTSIDE = realpathSync(mkTmpDir("webui-switch-facade-outside-"));
  DEFAULT_DIR = WS_DEFAULT;
  process.env.MCODE_WORKSPACE = DEFAULT_DIR;
  process.env.MCODE_WEBUI_WORKSPACE_ROOTS = WS_ROOT;
  // `lib/transcript.js` (the seam's reader) and `lib/session-tree.js`
  // both import this module. Registered ONCE, before any SUT import,
  // because both of them keep a live binding to it afterwards.
  t.mock.module(absPath("lib/sqlite-resolver.js"), {
    namedExports: {
      getMcodeBetterSqlite3: () => makeFakeDb(_dbOpts),
      _getBetterSqlite3Candidates: () => [],
    },
  });
});

after(() => {
  delete process.env.MCODE_WEBUI_EVENTS_PATH;
  delete process.env.MCODE_RUNTIME_DB;
  delete process.env.MCODE_WEBUI_WORKSPACE_ROOTS;
  delete process.env.MCODE_WORKSPACE;
  for (const d of [_eventsDir, WS_ROOT, DB_PATH, WS_OUTSIDE]) {
    if (d) rmTmpDir(d);
  }
});

/**
 * Boot the REAL facade over mocked storage. The sqlite fixture is what
 * decides whether the transcript read answers, so every data-plane test
 * that cares about the backfill passes `db` explicitly.
 */
async function bootFacade(t, { db = {}, store = [], acp = {}, mavis = {} } = {}) {
  await setupMocks(t, { mavis: { applyMavisUsageToCs: async () => {}, ...mavis } });
  // The sqlite fixture is read at CALL time by the mock registered in
  // `before()`. It cannot be re-registered per test: `lib/transcript.js`
  // holds a live binding to `lib/sqlite-resolver.js` after its first
  // import, and `mock.module` re-evaluates only the specifier it is given
  // — so a second registration here would leave the reader on the FIRST
  // test's fake and every later case would silently answer the wrong
  // thing. This is mock trap #2, and it is why `before()` owns it.
  _dbOpts = db;
  registerSessionsStore({ initial: store });
  registerAcpMock({
    getMcodeSessionsCacheSync: () => null,
    getMcodeSessionsStaleSync: () => null,
    getMcodeSessionTitle: async () => null,
    ...acp,
  });
  // Imported AFTER the mocks: the facade reaches its storage through
  // `await import()` at call time, so the registry mocks are what it
  // gets — and importing here (not at file scope) keeps the real module
  // the one under test in this section.
  return import(absPath("engine/session-switch.js"));
}

/** A minimal webui client state — only the fields the switch reads. */
function mkCs(workspaceDir = WS_A) {
  return {
    sessionId: "webui-previous",
    mcodeSessionId: null,
    sessionTitle: "Previous",
    chat: [],
    usage: { sessionInput: 7, sessionOutput: 8, sessionTotal: 15, contextUsed: 3 },
    workspace: { dir: workspaceDir, branch: "main", tree: null },
  };
}

/** Three transcript rows that exercise user / thinking+tool / assistant. */
function transcriptRows(sid) {
  return {
    [sid]: [
      {
        role: "user",
        turn_id: "turn-a",
        msg_id: "msg-user-1",
        data_json: JSON.stringify({ role: "user", msg_content: "调研工具" }),
      },
      {
        role: "assistant",
        turn_id: "turn-a",
        msg_id: "msg-assistant-1",
        data_json: JSON.stringify({
          role: "assistant",
          msg_content: "我先看看",
          thinking_content: "先搜索",
          tool_calls: [
            {
              tool_name: "bash",
              tool_call_id: "c1",
              tool_call_status: 2,
              tool_call_args: '{"command":"ls"}',
              tool_call_result_data: '{"content":[{"type":"text","text":"file1"}]}',
            },
          ],
        }),
      },
      {
        role: "assistant",
        turn_id: "turn-a",
        msg_id: "msg-assistant-2",
        data_json: JSON.stringify({ role: "assistant", msg_content: "结论" }),
      },
    ],
  };
}

const EXPECTED_LINES = [
  "› 调研工具",
  "▲ 先搜索",
  "● 我先看看",
  '→ bash  {"command":"ls"}',
  "  [completed]",
  "  file1",
  "● 结论",
  "§§ turn_msg=msg-assistant-2",
];

describe("M3-B6 — session switch family", () => {
  // ---------------------------------------------------------------------
  // 1. The declaration table and its soft-gate policy
  // ---------------------------------------------------------------------

  describe("SESSION_SWITCH_ENDPOINTS — one endpoint, one soft declaration", () => {
    test("covers exactly this batch's one endpoint", async () => {
      const { SESSION_SWITCH_ENDPOINTS } = await import(
        absPath("engine/session-switch.js")
      );
      assert.deepEqual(Object.keys(SESSION_SWITCH_ENDPOINTS), [
        "POST /api/sessions/switch",
      ]);
    });

    test("the row names the pair the ENRICHMENTS need, enforced softly", async () => {
      const { SESSION_SWITCH_ENDPOINTS } = await import(
        absPath("engine/session-switch.js")
      );
      const { ENGINE_CAPABILITY_KEYS } = await import(absPath("engine/index.js"));
      const row = SESSION_SWITCH_ENDPOINTS["POST /api/sessions/switch"];
      assert.deepEqual(Object.keys(row), [
        "capability",
        "subItem",
        "enforcement",
      ]);
      assert.deepEqual(row, {
        capability: "sessionCrud",
        subItem: "getSession",
        enforcement: "soft",
      });
      assert.ok(
        ENGINE_CAPABILITY_KEYS.includes(row.capability),
        "the declared capability must be a real registry key, not an invented one",
      );
    });

    test(`the DEFAULT transport (${ACP}) is UNREGISTERED and the gate says so`, async () => {
      const { checkSessionSwitchCapability } = await import(
        absPath("engine/session-switch.js")
      );
      const gate = checkSessionSwitchCapability("POST /api/sessions/switch", ACP);
      assert.equal(gate.gate, "unregistered-transport");
      assert.equal(gate.provider, null);
      assert.equal(gate.enforcement, "soft");
    });

    test(`the ${RUNTIME} transport resolves the v2 provider and checks the declaration`, async () => {
      const { checkSessionSwitchCapability } = await import(
        absPath("engine/session-switch.js")
      );
      const gate = checkSessionSwitchCapability("POST /api/sessions/switch", RUNTIME);
      assert.equal(gate.gate, "checked");
      assert.equal(gate.provider, "local-runtime-v2");
    });

    test("NO transport ever produces a capability error — the family declares no throwing gate", async () => {
      // A registry-driven assertion cannot cover the "provider declares
      // sessionCrud: none" case, because no registered provider does and
      // PROVIDERS is frozen. So the policy claim is pinned statically:
      // this module must not import `assertEngineCapability` (the only
      // thrower) and must not export an `assert*` gate. If a later
      // editor adds either, this test is the thing that says no.
      const src = readFileSync(
        fileURLToPath(absPath("engine/session-switch.js")),
        "utf8",
      );
      assert.equal(
        src.includes("assertEngineCapability("),
        false,
        "session-switch.js started calling the throwing gate — the 501 policy is a decision, not a refactor",
      );
      const mod = await import(absPath("engine/session-switch.js"));
      assert.deepEqual(
        Object.keys(mod).filter((k) => /^assert/i.test(k)),
        [],
        "this family must expose no assert* gate; use checkSessionSwitchCapability",
      );
    });

    test("an unknown endpoint key is a plain Error, never a capability error", async () => {
      const { checkSessionSwitchCapability } = await import(
        absPath("engine/session-switch.js")
      );
      let caught = null;
      try {
        checkSessionSwitchCapability("POST /api/sessions/nope", RUNTIME);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "an unknown key must throw");
      assert.equal(caught.code, "unknown_session_switch_endpoint");
      assert.equal(
        isEngineCapabilityNotSupportedError(caught),
        false,
        "caller confusion must never be dressed up as an engine limitation",
      );
    });
  });

  // ---------------------------------------------------------------------
  // 2. The four red lines
  // ---------------------------------------------------------------------

  describe("RED LINE 1 — 转录回填: a switch shows the conversation, it does not show an empty screen", () => {
    test("empty stored chat → the engine transcript lands in cs.chat, the response and the persisted record", async (t) => {
      const mod = await bootFacade(t, {
        db: { rowsBySql: { [await v2ProbeSql()]: transcriptRows(SID_A) } },
      });
      const cs = mkCs();
      const r = await mod.applyEngineSessionSwitch({ id: SID_A, cs, cid: "cid-1" });
      assert.equal(r.outcome, "ok");
      assert.deepEqual(cs.chat, EXPECTED_LINES, "cs.chat carries the mapped transcript");
      assert.deepEqual(
        r.payload.session.chat,
        EXPECTED_LINES,
        "the response carries the same lines the client state does",
      );
      const saved = getSessionsStore()[0];
      assert.deepEqual(saved.chat, EXPECTED_LINES, "and the wrapper was re-persisted");
      assert.equal(r.transcript.ok, true);
      assert.equal(
        r.transcript.decision,
        "empty",
        "first touch fires the EMPTY branch of the backfill rule",
      );
      assert.equal(r.transcript.reason, null, "and a successful read has no failure reason");
    });

    test("NEGATIVE half: a CLEAN stored chat is kept even though the engine read would answer", async (t) => {
      const mod = await bootFacade(t, {
        db: { rowsBySql: { [await v2ProbeSql()]: transcriptRows(SID_A) } },
        store: [
          {
            id: "webui-keep",
            mcodeSessionId: SID_A,
            title: "Keep",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: ["● mine already"],
          },
        ],
      });
      const cs = mkCs();
      const r = await mod.applyEngineSessionSwitch({
        id: "webui-keep",
        cs,
        cid: "cid-1",
      });
      assert.equal(r.outcome, "ok");
      assert.deepEqual(cs.chat, ["● mine already"], "a clean buffer is never clobbered");
      assert.equal(r.transcript, null, "and the read was not even attempted");
    });

    test("a read that fails NEVER breaks the switch (missing db / bad driver / schema drift)", async (t) => {
      // Three failure shapes, one promise: the switch answers 200 and
      // keeps the stored chat. This is the endpoint's oldest contract
      // and the reason the family's gate is soft.
      for (const [name, db] of [
        ["constructor throws", { constructThrows: true }],
        ["every prepare throws (schema drift)", {}],
      ]) {
        await t.test(name, async (t2) => {
          const mod = await bootFacade(t2, { db });
          const cs = mkCs();
          const r = await mod.applyEngineSessionSwitch({
            id: SID_A,
            cs,
            cid: "cid-1",
          });
          assert.equal(r.outcome, "ok", name);
          assert.equal(r.payload.ok, true, name);
          assert.deepEqual(r.payload.session.chat, [], name);
          assert.equal(r.transcript.ok, false, name);
          assert.ok(r.transcript.reason, name);
        });
      }
    });
  });

  describe("RED LINE 2 — cumulative detection: a polluted buffer is repaired, a clean one is not", () => {
    // Table-driven on the predicate, because the predicate is the whole
    // red line and a change to it must be reviewed as a rule change.
    const CUMULATIVE_TABLE = [
      ["empty buffer", [], false],
      ["one dot line", ["● only one"], false],
      [
        "non-cumulative segments",
        ["● seg one", "● seg two", "● seg three"],
        false,
      ],
      [
        "cumulative: a later line strictly contains an earlier one",
        ["● part one", "● part one plus part two"],
        true,
      ],
      [
        "cumulative anywhere in the buffer, not just the first pair",
        ["● a", "● b", "● a and b and c"],
        true,
      ],
      ["equal-length dots are NOT a superset", ["● ab", "● ba"], false],
      [
        "non-dot lines are ignored entirely",
        ["› prompt", "▲ thought", "→ tool  {}", "○ system"],
        false,
      ],
      [
        "a non-string entry does not throw the predicate",
        ["● prefix", null, 42, "● prefix and more"],
        true,
      ],
      ["a bare dot marker is not evidence", ["●", "● later"], false],
      ["a shorter later line is not a superset", ["● long line", "● short"], false],
    ];
    for (const [name, chat, expected] of CUMULATIVE_TABLE) {
      test(`chatLooksCumulative: ${name} → ${expected}`, async () => {
        const { chatLooksCumulative } = await import(
          absPath("engine/session-switch.js")
        );
        assert.equal(chatLooksCumulative(chat), expected);
      });
    }

    test("selectTranscriptBackfill reads the predicate into the three-branch rule", async () => {
      const { selectTranscriptBackfill } = await import(
        absPath("engine/session-switch.js")
      );
      assert.deepEqual(selectTranscriptBackfill([]), {
        storedHasChat: false,
        storedCumulative: false,
        shouldBackfill: true,
        reason: "empty",
      });
      assert.deepEqual(selectTranscriptBackfill(["● a", "● a and b"]), {
        storedHasChat: true,
        storedCumulative: true,
        shouldBackfill: true,
        reason: "stored_cumulative",
      });
      assert.deepEqual(selectTranscriptBackfill(["● a", "● b"]), {
        storedHasChat: true,
        storedCumulative: false,
        shouldBackfill: false,
        reason: "stored_shrinks",
      });
    });

    test("end to end: a cumulative stored buffer is replaced by the engine read and re-persisted", async (t) => {
      const mod = await bootFacade(t, {
        db: { rowsBySql: { [await v2ProbeSql()]: transcriptRows(SID_A) } },
        store: [
          {
            id: "webui-polluted",
            mcodeSessionId: SID_A,
            title: "Polluted",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: ["● seg one", "● seg one and seg two"],
          },
        ],
      });
      const cs = mkCs();
      const r = await mod.applyEngineSessionSwitch({
        id: "webui-polluted",
        cs,
        cid: "cid-1",
      });
      assert.equal(r.outcome, "ok");
      assert.deepEqual(cs.chat, EXPECTED_LINES, "the polluted buffer is gone");
      assert.deepEqual(getSessionsStore()[0].chat, EXPECTED_LINES, "and stays gone");
      assert.equal(r.transcript.ok, true);
    });

    test("a cumulative buffer whose read comes back EMPTY is preserved, not blanked", async (t) => {
      const mod = await bootFacade(t, {
        db: {},
        store: [
          {
            id: "webui-polluted-2",
            mcodeSessionId: SID_A,
            title: "Polluted",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: ["● seg one", "● seg one and seg two"],
          },
        ],
      });
      const cs = mkCs();
      const r = await mod.applyEngineSessionSwitch({
        id: "webui-polluted-2",
        cs,
        cid: "cid-1",
      });
      assert.equal(r.outcome, "ok");
      assert.deepEqual(
        cs.chat,
        ["● seg one", "● seg one and seg two"],
        "an empty read must not delete the user's last view",
      );
      assert.equal(
        r.transcript.decision,
        "stored_cumulative",
        "and the log says the pollution branch fired, not the empty one",
      );
    });
  });

  describe("RED LINE 3 — workspace containment: the switch writes a gated path or it does not write one", () => {
    test("an out-of-bounds stored workspace is REFUSED and the client state is untouched", async (t) => {
      const mod = await bootFacade(t, {
        store: [
          {
            id: "webui-outside",
            mcodeSessionId: SID_A,
            title: "Outside",
            workspace: WS_OUTSIDE,
            createdAt: 1,
            updatedAt: 1,
            chat: [],
          },
        ],
      });
      const cs = mkCs(WS_B);
      const before = JSON.parse(JSON.stringify(cs));
      const r = await mod.applyEngineSessionSwitch({
        id: "webui-outside",
        cs,
        cid: "cid-1",
      });
      assert.equal(r.outcome, "workspace_refused");
      assert.equal(r.statusHint, 400);
      assert.equal(r.audit, null, "a refused switch writes no audit event");
      assert.equal(r.payload.ok, false);
      assert.equal(r.payload.attempted, WS_OUTSIDE, "the 400 names the path it refused");
      assert.ok(typeof r.payload.error === "string" && r.payload.error.length > 0);
      assert.deepEqual(
        cs,
        before,
        "a refused switch must leave identity, chat, usage and workspace exactly as they were",
      );
    });

    test("an empty stored workspace falls back to the DEFAULT, never to the caller's current one", async (t) => {
      // The user-reported defect: "the file tree still shows the previous
      // project". The caller is sitting in projectB; the record has no
      // workspace of its own; the answer must be the default, not B.
      const mod = await bootFacade(t, { store: [] });
      const cs = mkCs(WS_B);
      const r = await mod.applyEngineSessionSwitch({ id: SID_A, cs, cid: "cid-1" });
      assert.equal(r.outcome, "ok");
      assert.equal(r.workspace.fallback, true);
      assert.equal(cs.workspace.dir, WS_DEFAULT);
      assert.notEqual(cs.workspace.dir, WS_B, "the current workspace must never be the fallback");
      assert.equal(r.payload.session.workspaceFallback, true);
    });

    test("a stored workspace wins over the default and the target record is never rewritten with the caller's", async (t) => {
      const mod = await bootFacade(t, {
        store: [
          {
            id: "webui-A",
            mcodeSessionId: SID_A,
            title: "Project A session",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: ["● a"],
          },
        ],
      });
      const cs = mkCs(WS_B);
      const r = await mod.applyEngineSessionSwitch({ id: "webui-A", cs, cid: "cid-1" });
      assert.equal(r.outcome, "ok");
      assert.equal(cs.workspace.dir, WS_A, "the file tree follows the switched session");
      assert.equal(r.workspace.fallback, false);
      assert.equal(getSessionsStore()[0].workspace, WS_A, "the record keeps its own workspace");
    });

    test("resolveSwitchWorkspace prefers target-first and reports the refusal shape", async () => {
      const { resolveSwitchWorkspace } = await import(
        absPath("engine/session-switch.js")
      );
      const refuse = (p) => ({ ok: false, error: `outside: ${p}` });
      const accept = (p) => ({ ok: true, path: p, real: p });
      // Target-first.
      assert.deepEqual(
        resolveSwitchWorkspace({ workspace: "  /ws/a  " }, {
          defaultWorkspace: "/ws/default",
          assertPath: accept,
        }),
        { ok: true, dir: "/ws/a", real: "/ws/a", fallback: false },
        "the stored value is trimmed and used as-is",
      );
      // Empty / missing / non-string → the default, flagged as a fallback.
      for (const record of [{}, { workspace: "" }, { workspace: "   " }, { workspace: 7 }]) {
        const got = resolveSwitchWorkspace(record, {
          defaultWorkspace: "/ws/default",
          assertPath: accept,
        });
        assert.equal(got.dir, "/ws/default", JSON.stringify(record));
        assert.equal(got.fallback, true, JSON.stringify(record));
      }
      // Refusal carries the attempted path so the 400 can be actionable.
      assert.deepEqual(
        resolveSwitchWorkspace({ workspace: "/nope" }, {
          defaultWorkspace: "/ws/default",
          assertPath: refuse,
        }),
        { ok: false, error: "outside: /nope", attempted: "/nope" },
      );
    });
  });

  describe("RED LINE 4 — single base session identity: one conversation, one record", () => {
    test("first touch creates exactly ONE record whose id IS the engine sid", async (t) => {
      const mod = await bootFacade(t, { store: [] });
      const r = await mod.applyEngineSessionSwitch({
        id: SID_A,
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(r.outcome, "ok");
      const store = getSessionsStore();
      assert.equal(store.length, 1, "one conversation must not produce two entries");
      assert.equal(store[0].id, SID_A, "the overlay record's id IS the engine sid");
      assert.equal(store[0].mcodeSessionId, SID_A);
      assert.equal(r.payload.session.id, SID_A);
      assert.equal(r.matchKind, null, "first touch is not a match against an existing record");
    });

    test("a second switch to the same sid REUSES the record — no second entry appears", async (t) => {
      const mod = await bootFacade(t, { store: [] });
      await mod.applyEngineSessionSwitch({ id: SID_A, cs: mkCs(), cid: "cid-1" });
      await mod.applyEngineSessionSwitch({ id: SID_A, cs: mkCs(WS_B), cid: "cid-1" });
      const store = getSessionsStore();
      assert.equal(store.length, 1, "repeated switches must hit the same record");
      assert.equal(store[0].id, SID_A);
    });

    test("resolveSwitchTarget prefers the engine sid over a webui uuid, the opposite of the write family", async () => {
      // The single-identity rule, stated as a resolution order. Two
      // discriminating cases, because the order is only OBSERVABLE when
      // both passes could match — and a reader who writes one fixture
      // will not notice that the other order passes it too.
      const { resolveSwitchTarget } = await import(absPath("engine/session-switch.js"));

      // (a) The label case, and the common one: an overlay record's id
      // IS its engine sid, so both passes match the same record and only
      // `matchKind` tells the two orders apart. It is observable — the
      // audit payload carries the label, and `new_from_mcode` vs
      // `mcodeSessionId` is the difference between "we just created
      // this" and "this already existed".
      const overlay = { id: SID_A, mcodeSessionId: SID_A, title: "Overlay" };
      assert.deepEqual(
        resolveSwitchTarget([overlay], SID_A),
        { index: 0, matchKind: "mcodeSessionId", target: overlay },
        "an overlay addressed by its sid is an mcodeSessionId match, not a webuiId one",
      );

      // (b) The conflict case: two records could answer, and the one
      // that IS the engine session wins.
      const bySid = { id: "webui-1", mcodeSessionId: SID_A };
      const byUuid = { id: SID_B, mcodeSessionId: null };
      const records = [byUuid, bySid];
      assert.deepEqual(resolveSwitchTarget(records, SID_A), {
        index: 1,
        matchKind: "mcodeSessionId",
        target: bySid,
      });
      assert.deepEqual(
        resolveSwitchTarget(records, SID_B),
        {
          index: 0,
          // No record is BOUND to SID_B — the one whose UUID is SID_B
          // has no mcodeSessionId at all — so the sid pass misses and the
          // uuid pass wins. The order is only observable in the case
          // where both passes could match.
          matchKind: "webuiId",
          target: byUuid,
        },
        "an id that is a record's uuid but no record's engine sid is a webuiId match",
      );
      assert.deepEqual(resolveSwitchTarget(records, "webui-1"), {
        index: 1,
        matchKind: "webuiId",
        target: bySid,
      });
      assert.deepEqual(resolveSwitchTarget(records, NOT_A_SID), {
        index: -1,
        matchKind: null,
        target: null,
      });
    });

    test("an id that is neither a record nor an engine sid is `not_found`, never an invented overlay", async (t) => {
      const mod = await bootFacade(t, { store: [] });
      const r = await mod.applyEngineSessionSwitch({
        id: NOT_A_SID,
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(r.outcome, "not_found");
      assert.equal(r.statusHint, 404);
      assert.deepEqual(r.payload, { ok: false, error: "session not found" });
      assert.equal(getSessionsStore().length, 0, "a wrong id must not create a record");
    });
  });

  // ---------------------------------------------------------------------
  // 3. The byte-for-byte wire shapes
  // ---------------------------------------------------------------------

  describe("the response shape is pinned byte-for-byte, in every outcome", () => {
    test("success: exact body string and key order", async (t) => {
      const mod = await bootFacade(t, {
        store: [
          {
            id: "webui-A",
            mcodeSessionId: SID_A,
            title: "T",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: ["● x"],
          },
        ],
      });
      const r = await mod.applyEngineSessionSwitch({
        id: "webui-A",
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(
        JSON.stringify(r.payload),
        `{"ok":true,"session":{"id":"webui-A","mcodeSessionId":"${SID_A}","title":"T",` +
          `"workspace":"${WS_A}","workspaceFallback":false,"chat":["● x"]}}`,
        "the success body's key ORDER is a frontend contract (url-restore reads workspace)",
      );
      assert.deepEqual(Object.keys(r.payload), ["ok", "session"]);
      assert.deepEqual(Object.keys(r.payload.session), [
        "id",
        "mcodeSessionId",
        "title",
        "workspace",
        "workspaceFallback",
        "chat",
      ]);
    });

    test("not_found / workspace_refused bodies, key order included", async (t) => {
      const mod = await bootFacade(t, {
        store: [
          {
            id: "webui-outside",
            mcodeSessionId: SID_A,
            title: "T",
            workspace: WS_OUTSIDE,
            createdAt: 1,
            updatedAt: 1,
            chat: [],
          },
        ],
      });
      const notFound = await mod.applyEngineSessionSwitch({
        id: NOT_A_SID,
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(
        JSON.stringify(notFound.payload),
        '{"ok":false,"error":"session not found"}',
      );
      const refused = await mod.applyEngineSessionSwitch({
        id: "webui-outside",
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.deepEqual(Object.keys(refused.payload), ["ok", "error", "attempted"]);
      assert.equal(refused.payload.attempted, WS_OUTSIDE);
    });

    test("a record with no mcodeSessionId and no chat still answers the same six-key body", async (t) => {
      const mod = await bootFacade(t, {
        store: [
          {
            id: "webui-local",
            title: "Local only",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: [],
          },
        ],
      });
      const r = await mod.applyEngineSessionSwitch({
        id: "webui-local",
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(r.outcome, "ok");
      assert.deepEqual(Object.keys(r.payload.session), [
        "id",
        "mcodeSessionId",
        "title",
        "workspace",
        "workspaceFallback",
        "chat",
      ]);
      assert.equal(r.payload.session.mcodeSessionId, null);
      assert.deepEqual(r.payload.session.chat, []);
    });

    test("the audit payload is the B01 contract, and first touch keeps its own label", async (t) => {
      const mod = await bootFacade(t, { store: [] });
      const r = await mod.applyEngineSessionSwitch({
        id: SID_A,
        cs: mkCs(),
        cid: "cid-9",
      });
      assert.equal(r.audit.event, "session.switch");
      assert.equal(r.audit.target, SID_A);
      assert.equal(r.audit.cid, "cid-9");
      assert.equal(r.audit.actor, "user");
      assert.deepEqual(Object.keys(r.audit.payload), [
        "from",
        "matchKind",
        "mcodeSessionId",
        "title",
        "workspace",
        "workspaceFallback",
      ]);
      assert.equal(r.audit.payload.from, "webui-previous", "the prior session is recorded");
      assert.equal(
        r.audit.payload.matchKind,
        "new_from_mcode",
        "a first touch is labelled new_from_mcode, NOT mcodeSessionId",
      );
      assert.equal(r.audit.payload.workspace, WS_DEFAULT);
      assert.equal(r.audit.payload.workspaceFallback, true);
    });

    test("an existing record reports its real matchKind in the audit", async (t) => {
      const mod = await bootFacade(t, {
        store: [
          {
            id: "webui-A",
            mcodeSessionId: SID_A,
            title: "T",
            workspace: WS_A,
            createdAt: 1,
            updatedAt: 1,
            chat: [],
          },
        ],
      });
      const bySid = await mod.applyEngineSessionSwitch({
        id: SID_A,
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(bySid.matchKind, "mcodeSessionId");
      assert.equal(bySid.audit.payload.matchKind, "mcodeSessionId");
      const byUuid = await mod.applyEngineSessionSwitch({
        id: "webui-A",
        cs: mkCs(),
        cid: "cid-1",
      });
      assert.equal(byUuid.matchKind, "webuiId");
      assert.equal(byUuid.audit.payload.matchKind, "webuiId");
    });
  });

  // ---------------------------------------------------------------------
  // 4. The pure derivations
  // ---------------------------------------------------------------------

  describe("the pure derivations, on their inputs", () => {
    test("isSwitchableMcodeSessionId is the 32-hex rule and nothing looser", async () => {
      const { isSwitchableMcodeSessionId } = await import(
        absPath("engine/session-switch.js")
      );
      for (const good of [SID_A, SID_B, `mvs_${"a".repeat(32)}`]) {
        assert.equal(isSwitchableMcodeSessionId(good), true, good);
      }
      for (const bad of [
        "mvs_short",
        `mvs_${"a".repeat(31)}`,
        `mvs_${"a".repeat(33)}`,
        `mvs_${"A".repeat(32)}`,
        "webui-1",
        "",
        null,
        undefined,
        42,
      ]) {
        assert.equal(isSwitchableMcodeSessionId(bad), false, String(bad));
      }
    });

    test("lookupCachedMcodeTitle probes the current ws, then the stale reader, then the unfiltered key", async () => {
      const { lookupCachedMcodeTitle } = await import(
        absPath("engine/session-switch.js")
      );
      const fresh = (ws) =>
        ws === "/ws/a" ? [{ sessionId: SID_A, title: "from fresh" }] : null;
      const stale = () => [{ sessionId: SID_A, title: "from stale" }];
      assert.equal(
        lookupCachedMcodeTitle(SID_A, "/ws/a", { fresh, stale }),
        "from fresh",
        "the fresh reader for the current workspace wins",
      );
      assert.equal(
        lookupCachedMcodeTitle(SID_A, "/ws/other", { fresh, stale }),
        "from stale",
        "a miss falls through to the stale reader",
      );
      assert.equal(
        lookupCachedMcodeTitle(SID_A, "/ws/none", {
          fresh: () => null,
          stale: () => null,
        }),
        null,
        "a total miss is null so the caller can pay for the ACP path",
      );
      assert.equal(lookupCachedMcodeTitle("", "/ws/a", { fresh, stale }), null);
      // A throwing cache reader is a miss, not a crash: the switch must
      // still be able to fall back to the engine title.
      assert.equal(
        lookupCachedMcodeTitle(SID_A, "/ws/a", {
          fresh: () => {
            throw new Error("cache exploded");
          },
          stale: () => null,
        }),
        null,
      );
    });

    test("lookupCachedMcodeTitle finds a title cached under the unfiltered key", async () => {
      const { lookupCachedMcodeTitle } = await import(
        absPath("engine/session-switch.js")
      );
      // getMcodeSessionsForWorkspace("") caches the UNFILTERED list, so a
      // cache walked without a workspace still answers the first touch.
      const unfiltered = [{ sessionId: SID_A, title: "Unfiltered title" }];
      assert.equal(
        lookupCachedMcodeTitle(SID_A, "/ws/a", {
          fresh: (ws) => (ws === "" ? unfiltered : null),
          stale: () => null,
        }),
        "Unfiltered title",
      );
    });

    test("applySwitchedSessionToClientState sets identity, chat, usage and workspace — and nothing else", async () => {
      const { applySwitchedSessionToClientState } = await import(
        absPath("engine/session-switch.js")
      );
      const cs = {
        sessionId: "old",
        mcodeSessionId: "old-sid",
        sessionTitle: "Old",
        chat: ["● stale"],
        usage: { sessionInput: 7, sessionOutput: 8, sessionTotal: 15, contextUsed: 3 },
        workspace: { dir: "/ws/old", branch: "main", tree: ["t"] },
        lastUsedWorkspace: "/ws/last-used",
      };
      const out = applySwitchedSessionToClientState(cs, {
        target: { id: "new", mcodeSessionId: SID_A, title: "New", chat: ["● fresh"] },
        workspaceDir: "/ws/new",
      });
      assert.equal(out, cs, "the same object is mutated in place");
      assert.equal(cs.sessionId, "new");
      assert.equal(cs.mcodeSessionId, SID_A);
      assert.equal(cs.sessionTitle, "New");
      assert.deepEqual(cs.chat, ["● fresh"]);
      assert.deepEqual(cs.usage, {
        sessionInput: 0,
        sessionOutput: 0,
        sessionTotal: 0,
        contextUsed: 3,
      }, "the three cumulative counters zero, every other key preserved");
      assert.deepEqual(cs.workspace, { dir: "/ws/new", branch: null, tree: null });
      assert.equal(
        cs.lastUsedWorkspace,
        "/ws/last-used",
        "switching is browsing: last-used-workspace must not move",
      );
    });

    test("applySwitchedSessionToClientState normalises the three optional target fields", async () => {
      const { applySwitchedSessionToClientState } = await import(
        absPath("engine/session-switch.js")
      );
      const cs = { usage: {} };
      applySwitchedSessionToClientState(cs, {
        target: { id: "u1" },
        workspaceDir: "/ws/x",
      });
      assert.equal(cs.mcodeSessionId, null, "a record with no engine sid binds to null");
      assert.equal(cs.sessionTitle, "Untitled", "and an absent title reads as Untitled");
      assert.deepEqual(cs.chat, [], "a non-array chat is an empty chat, never a crash");
    });
  });

  // ---------------------------------------------------------------------
  // 5. The route
  // ---------------------------------------------------------------------

  describe("handleSwitchSession — HTTP parsing, status codes, and the fail-closed audit", () => {
    /** Every export the REAL facade has, so a partial mock fails loud. */
    const FACADE_EXPORTS = [
      "SESSION_SWITCH_ENDPOINTS",
      "applyEngineSessionSwitch",
      "applySwitchedSessionToClientState",
      "chatLooksCumulative",
      "checkSessionSwitchCapability",
      "isSwitchableMcodeSessionId",
      "lookupCachedMcodeTitle",
      "readEngineSwitchTranscript",
      "resolveSessionSwitchProvider",
      "resolveSwitchTarget",
      "resolveSwitchWorkspace",
      "selectTranscriptBackfill",
    ];
    function mockFacade(t, impls) {
      const namedExports = {};
      for (const name of FACADE_EXPORTS) {
        namedExports[name] = () => {
          throw new Error(`B6 test called engine/session-switch.js#${name}, which this case did not stub`);
        };
      }
      Object.assign(namedExports, impls);
      t.mock.module(absPath("engine/session-switch.js"), { namedExports });
    }
    const loadRoute = async () =>
      import(`${absPath("routes/sessions.js")}?bust=${bust++}`);

    const OK_AUDIT = {
      event: "session.switch",
      target: "webui-A",
      cid: "tab-1",
      actor: "user",
      payload: {
        from: "webui-previous",
        matchKind: "webuiId",
        mcodeSessionId: SID_A,
        title: "T",
        workspace: WS_A,
        workspaceFallback: false,
      },
    };
    const OK_BODY = {
      ok: true,
      session: {
        id: "webui-A",
        mcodeSessionId: SID_A,
        title: "T",
        workspace: WS_A,
        workspaceFallback: false,
        chat: ["● x"],
      },
    };

    test("a missing id is the route's own 400, in the route's own words", async (t) => {
      await setupMocks(t, {});
      mockFacade(t, {});
      const route = await loadRoute();
      // `{id: 42}` is deliberately NOT in this list: `(payload.id || "").trim()`
      // throws a TypeError on a number, which is the pre-facade behaviour
      // and a 500 rather than a 400. Tightening it would be a behaviour
      // change dressed as a hardening, and this batch promises none —
      // it is recorded as a question for the request-validation pass
      // instead (see KNOWN DEBT, `routes/sessions.js`).
      for (const body of [{}, { id: "" }, { id: "   " }, { id: null }]) {
        const res = mkRes();
        await route.handleSwitchSession(jsonReq(body), res, { cs: mkCs(), cid: "tab-1" });
        assert.equal(res.written[0].status, 400);
        // Pre-existing asymmetry, preserved: this body is the ONE shape
        // on this endpoint that does not carry the charset.
        assert.equal(res.written[0].headers["Content-Type"], "application/json");
        assert.equal(res.written[1].body, '{"ok":false,"error":"id required"}');
      }
    });

    // Table-driven across every outcome the facade can report. The
    // status, the Content-Type and the body are all pinned; the two
    // Content-Type spellings are the pre-existing asymmetry and must not
    // be tidied into one.
    const OUTCOMES = [
      [
        "not_found",
        404,
        "application/json",
        '{"ok":false,"error":"session not found"}',
      ],
      [
        "workspace_refused",
        400,
        "application/json; charset=utf-8",
        JSON.stringify({ ok: false, error: "outside: /nope", attempted: "/nope" }),
      ],
    ];
    for (const [outcome, status, contentType, body] of OUTCOMES) {
      test(`${outcome} → ${status} with Content-Type ${contentType}`, async (t) => {
        await setupMocks(t, {});
        mockFacade(t, {
          applyEngineSessionSwitch: async () => ({
            outcome,
            statusHint: status,
            payload: JSON.parse(body),
            audit: null,
          }),
        });
        const route = await loadRoute();
        const res = mkRes();
        await route.handleSwitchSession(jsonReq({ id: "x" }), res, {
          cs: mkCs(),
          cid: "tab-1",
        });
        assert.equal(res.written[0].status, status);
        assert.equal(res.written[0].headers["Content-Type"], contentType);
        assert.equal(res.written[1].body, body);
        assert.equal(res.written.length, 2, "a non-ok outcome writes exactly one response");
      });
    }

    test("the route writes the facade's audit event verbatim, then the state push, then the 200", async (t) => {
      await setupMocks(t, {});
      mockFacade(t, {
        applyEngineSessionSwitch: async () => ({
          outcome: "ok",
          statusHint: 200,
          matchKind: "webuiId",
          workspace: { ok: true, dir: WS_A, fallback: false },
          transcript: null,
          audit: OK_AUDIT,
          payload: OK_BODY,
        }),
      });
      const route = await loadRoute();
      const res = mkRes();
      await route.handleSwitchSession(jsonReq({ id: "webui-A" }), res, {
        cs: mkCs(),
        cid: "tab-1",
      });
      assert.equal(res.written[0].status, 200);
      assert.equal(res.written[0].headers["Content-Type"], "application/json");
      assert.equal(res.written[1].body, JSON.stringify(OK_BODY));
      // The audit really landed: lib/events.js appends one NDJSON line
      // per call, and the line carries the event name.
      const auditPath = process.env.MCODE_WEBUI_EVENTS_PATH;
      assert.ok(existsSync(auditPath), "the switch wrote no audit line at all");
      const raw = readFileSync(auditPath, "utf8");
      const last = raw.trim().split("\n").pop();
      assert.ok(last.includes("session.switch"), `last audit line: ${last}`);
    });

    test("a failed audit is fail-closed: 500, and the audit sink's own body", async (t) => {
      await setupMocks(t, {});
      mockFacade(t, {
        applyEngineSessionSwitch: async () => ({
          outcome: "ok",
          statusHint: 200,
          audit: OK_AUDIT,
          payload: OK_BODY,
        }),
      });
      const route = await loadRoute();
      // Point the audit stream at a DIRECTORY: `events.js#append` writes
      // atomically and throws EISDIR, which is the failure the fail-closed
      // branch exists for. `_eventsPath()` reads the env lazily, so no
      // re-import is needed.
      const prev = process.env.MCODE_WEBUI_EVENTS_PATH;
      const asDir = join(_eventsDir, "events-as-a-directory");
      mkdirSync(asDir, { recursive: true });
      process.env.MCODE_WEBUI_EVENTS_PATH = asDir;
      try {
        const res = mkRes();
        await route.handleSwitchSession(jsonReq({ id: "webui-A" }), res, {
          cs: mkCs(),
          cid: "tab-1",
        });
        assert.equal(res.written[0].status, 500);
        assert.equal(
          res.written[0].headers["Content-Type"],
          "application/json; charset=utf-8",
        );
        assert.equal(
          res.written[1].body,
          '{"ok":false,"error":"audit write failed","detail":"session.switch"}',
        );
      } finally {
        process.env.MCODE_WEBUI_EVENTS_PATH = prev;
      }
    });

    test("PROOF: a marker error from the facade escapes the route", async (t) => {
      // Without a fresh `?bust=` re-import, `mock.module` would leave the
      // route holding the PREVIOUS test's live binding, the marker would
      // never be thrown, and this assertion would fail — which is the
      // point: it is the only assertion in this section that cannot pass
      // by accident.
      await setupMocks(t, {});
      const marker = new Error("B6-MOCK-WAS-NOT-HONOURED");
      mockFacade(t, {
        applyEngineSessionSwitch: async () => {
          throw marker;
        },
      });
      const route = await loadRoute();
      let caught = null;
      try {
        await route.handleSwitchSession(jsonReq({ id: "webui-A" }), mkRes(), {
          cs: mkCs(),
          cid: "tab-1",
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(
        caught,
        "the route swallowed the facade error — either the mock did not take, or the route grew a catch",
      );
      assert.equal(caught, marker, "the error is the mock's, by identity");
    });
  });

  // ---------------------------------------------------------------------
  // 6. The transcript seam, and what this batch retired
  // ---------------------------------------------------------------------

  describe("the transcript seam", () => {
    test("readEngineSwitchTranscript never throws — every failure is a value", async (t) => {
      const mod = await bootFacade(t, { db: { constructThrows: true } });
      for (const mcodeSessionId of [SID_A, "not-a-sid", ""]) {
        const r = await mod.readEngineSwitchTranscript({ mcodeSessionId });
        assert.equal(r.ok, false, mcodeSessionId);
        assert.equal(r.source, "none");
        assert.deepEqual(r.lines, []);
        assert.ok(r.reason, "a failure always names its reason for the operator log");
      }
    });

    test("readEngineSwitchTranscript reports the gate and the transport it asked under", async (t) => {
      const mod = await bootFacade(t, { db: {} });
      const r = await mod.readEngineSwitchTranscript({ mcodeSessionId: SID_A });
      assert.equal(r.gate.endpoint, "POST /api/sessions/switch");
      assert.equal(r.gate.enforcement, "soft");
      assert.equal(
        r.gate.gate === "unregistered-transport" || r.gate.gate === "checked",
        true,
        `unexpected gate ${r.gate.gate}`,
      );
    });

    test("RETIRED: routes/sessions.js no longer names lib/transcript.js at all", async () => {
      // The part of the probe debt this batch actually collected. A
      // static source assertion is the right instrument here: the claim
      // is about an IMPORT GRAPH, and this suite has no render harness
      // that could observe it. `export.js`'s comment still names the
      // switch path by prose, which is exactly the kind of drift the
      // assertion below is here to catch.
      const src = readFileSync(
        fileURLToPath(absPath("routes/sessions.js")),
        "utf8",
      );
      assert.equal(
        /from\s+"\.\.\/lib\/transcript\.js"/.test(src),
        false,
        "the route must not import the transcript reader directly any more",
      );
      assert.equal(
        /loadTranscriptChatLines|readMcodeTranscript/.test(src),
        false,
        "the route must not call a transcript reader directly any more",
      );
      // And the read is reachable exactly once, through the seam.
      const facadeSrc = readFileSync(
        fileURLToPath(absPath("engine/session-switch.js")),
        "utf8",
      );
      assert.equal(
        /import\("\.\.\/lib\/transcript\.js"\)/.test(facadeSrc),
        true,
        "the seam is the single owner of the transcript read now",
      );
    });

    test("KEPT, deliberately: the probe set behind the seam is unchanged", async (t) => {
      // KNOWN DEBT 1. The 3-candidate legacy probe set is still the
      // implementation, because the default `acp` transport has no
      // engine surface to replace it with and export's enrichment is
      // byte-pinned to those same candidates. This test is the tripwire
      // that makes the debt VISIBLE: if a later batch swaps the seam to
      // the engine's `getMessages`, the switch's line set changes here
      // and the failure names the batch that has to justify it.
      const mod = await bootFacade(t, {
        db: { rowsBySql: { [await v2ProbeSql()]: transcriptRows(SID_A) } },
      });
      const r = await mod.readEngineSwitchTranscript({ mcodeSessionId: SID_A });
      assert.equal(r.ok, true);
      assert.equal(r.probeTable, "local_runtime_message_rows");
      assert.equal(r.probe, "v2-data-json", "the v2 data_json probe is the one that answers");
      assert.equal(r.messageCount, 3);
    });
  });
});
