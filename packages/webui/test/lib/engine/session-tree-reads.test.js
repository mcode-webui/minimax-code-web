// webui/test/lib/engine/session-tree-reads.test.js
//
// M3-B2: the session-tree family's engine facade (GET /api/session-tree).
//
// #8 is the main↔subagent communication spine. The hierarchy the sidebar
// renders is built from `parent_session_id`, so THREE things are pinned
// here, each of them something a refactor could plausibly break while
// looking like a no-op:
//
//   1. The NODE SHAPE. The wire node is exactly
//      `{id, title, agent, kind, status, updatedAt, children}` — and in
//      particular it carries NO `parent_session_id` key. The hierarchy is
//      structural (via `children`), not a field on the node. The batch
//      brief asked whether such a key is omitted or `null`; the truthful
//      answer, measured against the real 299-node tree before the
//      refactor, is that the key does not exist at all. The key SET is
//      asserted exactly, not by subset, so both halves stay honest.
//   2. The HIERARCHY FILTER. `buildTree` attaches a child to the root
//      session named by its `parent_session_id`, in the SAME directory.
//      Anything that does not attach — an orphan (parent not in the row
//      set), a cross-directory parent, a grandchild whose parent is
//      itself a child, a child of a `root` container row, anything in a
//      cycle — is DROPPED SILENTLY. That is long-standing behaviour this
//      batch must not change, so it is pinned rather than left to a diff.
//   3. The GATE IS REAL. #8 is 100% engine data, so a provider that
//      declares no session listing must produce
//      EngineCapabilityNotSupportedError → 501, never an empty tree
//      (#110 fake-success). And the route must PROPAGATE that error
//      rather than folding it into its own `{ok:false}` soft-fail body —
//      that propagation is the one place this batch could have turned a
//      501 into a 200, so it has its own test.
//
// Boundaries probed empirically against the PRE-refactor route, not
// assumed from the batch plan (which was wrong on this point): #8 reads
// exactly one query parameter, `refresh`. `limit`, `offset`, `page` and
// `cursor` are NOT read — `?limit=1` returns the whole tree. The only
// cap is the internal MAX_ROWS = 5000 with `truncated: true`. The
// "limit 缺省/0/超上限" cases below therefore assert the real contract:
// unknown parameters are ignored and nothing truncates below MAX_ROWS.
//
// Test style follows test/lib/engine/session-reads.test.js (batch B1):
// table-driven, one row per case.
//
// Two module-mock traps, both learned in B3 while adding the sibling
// `usage-reads.test.js`, and both recorded here because this suite is where
// a future batch will look for the answer:
//
//   1. `t.mock.module` REPLACES THE WHOLE NAMESPACE, it does not merge. A
//      mock that names only the export the test cares about leaves every
//      other name undefined, and a consumer that imports more than one name
//      from the mocked module then fails at INSTANTIATION with
//      `SyntaxError: The requested module '…' does not provide an export
//      named '…'` — a failure that reads like a product bug and is not
//      one. In this suite it does not bite, because `routes/sessions.js`
//      imports exactly one name from `engine/session-tree-reads.js`; in
//      `routes/usage.js` it does, because that route binds three reads at
//      module scope. When a facade grows a second call, the mock has to
//      grow with it — stub the rest with something that throws, so an
//      unexpected call is loud instead of returning a plausible payload.
//   2. `mock.module` only re-evaluates the MOCKED specifier. A consumer
//      already in the registry keeps its old LIVE BINDING, so a second test
//      in the same file silently reuses the first test's mock and passes for
//      the wrong reason. Every route re-import below therefore carries a
//      fresh `?bust=N`; deleting that query turns nine tests in this file
//      red, which is the cheapest proof the mechanism is load-bearing.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";
import { setupMocks, absPath } from "../../helpers/_setup.js";

// ---------------------------------------------------------------------------
// Fixture — built BEFORE any server module is imported, and that ordering is
// load-bearing, not stylistic.
//
// `lib/config.js` resolves MCODE_RUNTIME_DB and SESSIONS_DB at MODULE LOAD,
// and `lib/session-tree.js` / `lib/sessions.js` import it statically. So a
// `before()` hook that set the env would be too late: the first static
// import of anything that reaches config.js would already have frozen the
// real ~/.minimax paths, and the fixture would silently read the
// developer's real database. Hence: build the tmp dir, create the db and
// set the env here at module top level, and only then import server code.
// ---------------------------------------------------------------------------

const tmpDir = mkTmpDir("webui-tree-facade-");
const dbPath = join(tmpDir, "runtime-state.sqlite");
const sessionsPath = join(tmpDir, "sessions.json");

const FIXTURE_ROWS = [
  // id, parent, type, agent, title, dir-suffix
  ["m1", null, "branch", "main-agent", "主会话", ""],
  ["c1", "m1", null, "coder", "子 agent", ""],
  ["c2", "m1", null, "planner", "子 agent 二", ""],
  // a grandchild — must NOT render
  ["g1", "c1", null, "tester", "孙 agent", ""],
  // an orphan — parent not in the row set
  ["orphan", "does-not-exist", null, null, "孤儿", ""],
  // a `root` container row and a child hanging off it — neither renders
  ["rc", null, "root", null, "容器", ""],
  ["under-rc", "rc", null, null, "容器下的子节点", ""],
  // a cross-directory child — must NOT render
  ["xd", "m1", null, null, "跨目录子节点", "-other"],
  // a self-parent and a two-node cycle — neither renders, neither hangs
  ["self", "self", null, null, "自环", ""],
  ["cyc-a", "cyc-b", null, null, "环 A", ""],
  ["cyc-b", "cyc-a", null, null, "环 B", ""],
  // title boundaries
  ["t-quote", null, "branch", null, 'a"b\\c', ""],
  ["t-html", null, "branch", null, "<script>alert(1)</script>&amp;", ""],
  ["t-multi", null, "branch", null, "第一行\n第二行\r\n第三行\t制表", ""],
  ["t-emoji", null, "branch", null, "🚀 עברית مرحبا", ""],
  ["t-long", null, "branch", null, "长".repeat(5000), ""],
  ["t-empty", null, "branch", null, "", ""],
  ["t-null", null, "branch", null, null, ""],
  // filtered by the SQL WHERE clause — must never reach buildTree
  ["f-archived", null, "branch", null, "已归档", ""],
  ["f-hidden", null, "branch", null, "不可见", ""],
  ["f-peek", null, "branch", null, "peek", ""],
  ["f-cron", null, "branch", null, "cron", ""],
  ["f-nodir", null, "branch", null, "无目录", ""],
];

// Build the db with spawnSync(SQLITE3_BIN) rather than requiring a native
// binding — the same approach test/lib/mcode-session-delete.test.js uses,
// so this suite does not depend on a compiled module being present.
const sqlRows = FIXTURE_ROWS.map(([id, parent, type, agent, title, dirSuffix]) => {
  const dir = `${tmpDir}/proj${dirSuffix}`;
  const q = (v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  return `INSERT INTO local_runtime_sessions
    (session_id, record_json, updated_at_ms, agent_name, session_type, status,
     archived, visibility, session_kind, parent_session_id, workspace_dir, title, created_at_ms)
    VALUES (${q(id)}, '{}', 1000, ${q(agent)}, ${q(type)}, 'idle',
            ${id === "f-archived" ? 1 : 0},
            ${id === "f-hidden" ? "'hidden'" : "'visible'"},
            ${id === "f-peek" ? "'peek'" : id === "f-cron" ? "'cron'" : "'conversation'"},
            ${q(parent)}, ${id === "f-nodir" ? "NULL" : q(dir)}, ${q(title)}, 1000);`;
}).join("\n");

// sqlite3 has no way to create a file with a schema in one -cmd batch on
// every platform, so the DDL is passed as a single argument like the other
// suites do.
const SQLITE3_BIN = process.env.SQLITE3_BIN || "sqlite3";
const DDL = `
  CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL, agent_name TEXT, session_type TEXT,
    status TEXT, archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible',
    session_kind TEXT NOT NULL DEFAULT 'conversation',
    parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
  );
  ${sqlRows}
`;
{
  const r = spawnSync(SQLITE3_BIN, [dbPath, DDL], { encoding: "utf8" });
  assert.equal(r.status, 0, `sqlite3 create failed: ${r.stderr}`);
}
// A custom title for m1, so the customTitles overlay is exercised too.
writeFileSync(
  sessionsPath,
  JSON.stringify([
    { id: "w1", mcodeSessionId: "m1", title: "改过名的主会话", titleCustom: true },
    { id: "w2", mcodeSessionId: "c1", title: "不该生效", titleCustom: false },
  ]),
);

process.env.MCODE_RUNTIME_DB = dbPath;
process.env.MCODE_WEBUI_SESSIONS_DB = sessionsPath;

// --- now, and only now, the server modules -------------------------------
const { ENGINE_CAPABILITY_KEYS } = await import("../../../server/engine/index.js");
const {
  SESSION_TREE_ENDPOINTS,
  assertSessionTreeCapability,
  readEngineSessionTree,
  resolveSessionTreeProvider,
} = await import("../../../server/engine/session-tree-reads.js");
const { buildTree } = await import("../../../server/lib/session-tree.js");
const {
  EngineCapabilityNotSupportedError,
  isEngineCapabilityNotSupportedError,
  engineCapabilityHttpResponse,
} = await import("../../../server/engine/errors.js");
const { assertEngineCapability } = await import("../../../server/engine/capabilities.js");

const ENDPOINT = "GET /api/session-tree";

after(() => {
  rmTmpDir(tmpDir);
  delete process.env.MCODE_RUNTIME_DB;
  delete process.env.MCODE_WEBUI_SESSIONS_DB;
});

/** A `buildTree` row, defaulted so each case only states what it is about. */
const row = (o) => ({
  session_id: o.id,
  title: o.title ?? null,
  agent_name: o.agent ?? null,
  session_kind: o.kind ?? "conversation",
  session_type: o.type ?? "branch",
  parent_session_id: o.parent ?? null,
  workspace_dir: o.dir ?? "/w/proj",
  status: o.status ?? "idle",
  updated_at_ms: o.at ?? 1,
  created_at_ms: o.at ?? 1,
});

/** Flatten an assembled tree into `{id, depth, node}` records. */
function flatten(tree) {
  const out = [];
  for (const project of tree) {
    for (const dir of project.directories) {
      for (const session of dir.sessions) {
        const walk = (node, depth) => {
          out.push({ id: node.id, depth, node });
          for (const child of node.children || []) walk(child, depth + 1);
        };
        walk(session, 0);
      }
    }
  }
  return out;
}

/** The session ids the client actually receives, in render order, with depth. */
const visible = (tree) => flatten(tree).map((n) => [n.id, n.depth]);

// ---------------------------------------------------------------------------
// 1. The endpoint → capability declaration table
// ---------------------------------------------------------------------------

describe("SESSION_TREE_ENDPOINTS — this batch's declaration table", () => {
  // Table-driven. Editing a row is a capability decision and must be
  // reviewed as one, so the table IS the assertion.
  const TABLE = [[ENDPOINT, "sessionCrud", "listSessions"]];

  for (const [endpoint, capability, subItem] of TABLE) {
    test(`${endpoint} declares ${capability}.${subItem}`, () => {
      const need = SESSION_TREE_ENDPOINTS[endpoint];
      assert.equal(need.capability, capability);
      assert.equal(need.subItem, subItem);
    });
  }

  test("the table carries exactly the endpoints this batch routes", () => {
    assert.deepEqual(Object.keys(SESSION_TREE_ENDPOINTS).sort(), [ENDPOINT]);
  });

  test("the capability is a real key of the 14-key registry", () => {
    assert.ok(ENGINE_CAPABILITY_KEYS.includes(SESSION_TREE_ENDPOINTS[ENDPOINT].capability));
  });
});

// ---------------------------------------------------------------------------
// 2. Provider resolution + the hard gate
// ---------------------------------------------------------------------------

describe("resolveSessionTreeProvider / assertSessionTreeCapability", () => {
  // Table-driven. Absent means "no provider claims this transport yet"
  // (M4), which is NOT the same answer as "capability unavailable".
  const TRANSPORTS = [
    ["runtime", true, "checked"],
    ["acp", false, "unregistered-transport"],
    ["exec", false, "unregistered-transport"],
    ["", false, "unregistered-transport"],
  ];

  for (const [transport, hasProvider, gate] of TRANSPORTS) {
    test(`transport "${transport}" → provider=${hasProvider} gate=${gate}`, () => {
      const provider = resolveSessionTreeProvider(transport);
      assert.equal(provider !== null, hasProvider);
      const g = assertSessionTreeCapability(ENDPOINT, transport);
      assert.equal(g.gate, gate);
      assert.equal(g.endpoint, ENDPOINT);
      assert.equal(g.capability, "sessionCrud");
      assert.equal(g.subItem, "listSessions");
    });
  }

  test("an unknown endpoint is caller confusion, not an engine limitation", () => {
    // A plain Error, so the HTTP layer never answers 501 for a typo in
    // webui's own code.
    assert.throws(
      () => assertSessionTreeCapability("GET /api/nope", "runtime"),
      (err) => {
        assert.ok(!(err instanceof EngineCapabilityNotSupportedError));
        assert.equal(err.code, "unknown_session_tree_endpoint");
        assert.match(err.message, /not part of the session-tree family/);
        return true;
      },
    );
  });
});

describe("the tree gate refuses a provider that cannot list sessions", () => {
  // The registered providers declare `full` today, so — exactly as in B1 —
  // only this file can prove the gate WOULD bite. A route that answered
  // `{ok:true, projects:[]}` would be the #110 failure mode.
  const allFull = () => Object.fromEntries(ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }]));
  const PARTIAL_NO_LIST = {
    ...allFull(),
    sessionCrud: {
      level: "partial",
      missing: ["listSessions"],
      reason: "test fixture: provider exposes no session listing",
    },
  };
  const NONE = {
    ...allFull(),
    sessionCrud: { level: "none", reason: "test fixture: interface-absent" },
  };

  test("a `none` declaration throws, and maps to 501", () => {
    const need = SESSION_TREE_ENDPOINTS[ENDPOINT];
    assert.throws(
      () => assertEngineCapability(NONE, need.capability, "fixture-provider"),
      (err) => {
        assert.ok(isEngineCapabilityNotSupportedError(err));
        assert.equal(err.capability, "sessionCrud");
        assert.equal(err.provider, "fixture-provider");
        const { status, payload } = engineCapabilityHttpResponse(err);
        assert.equal(status, 501);
        assert.equal(payload.code, "engine_capability_not_supported");
        return true;
      },
    );
  });

  test("a `partial` declaration missing listSessions throws, naming the method", () => {
    const need = SESSION_TREE_ENDPOINTS[ENDPOINT];
    assert.throws(
      () => assertEngineCapability(PARTIAL_NO_LIST, need.capability, "fixture-provider", need.subItem),
      (err) => {
        assert.deepEqual(err.missing, ["listSessions"]);
        return true;
      },
    );
  });

  test("a `partial` declaration that KEEPS listSessions lets the tree through", () => {
    const need = SESSION_TREE_ENDPOINTS[ENDPOINT];
    assert.doesNotThrow(() =>
      assertEngineCapability(
        { ...allFull(), sessionCrud: { level: "partial", missing: ["deleteSession"], reason: "x" } },
        need.capability,
        "fixture-provider",
        need.subItem,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The red line: node shape, and which rows reach the client
// ---------------------------------------------------------------------------

describe("buildTree — the node shape the sidebar depends on", () => {
  const roots = new Map([["/w/proj", "/w/proj"]]);

  test("a ROOT node carries 7 keys including children, and NO parent_session_id", () => {
    const tree = buildTree(
      [row({ id: "m1", title: "主会话" }), row({ id: "c1", parent: "m1", title: "子 agent" })],
      roots,
    );
    const root = flatten(tree)[0].node;
    assert.deepEqual(
      Object.keys(root).sort(),
      ["agent", "children", "id", "kind", "status", "title", "updatedAt"],
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(root, "parent_session_id"),
      false,
      "the node must NOT carry parent_session_id — the tree is structural",
    );
  });

  test("a CHILD node carries 6 keys — it has NO `children` key at all", () => {
    // Measured against the real 299-node tree before the refactor: 233
    // root nodes carry `children`, all 66 child nodes do NOT.
    // `buildTree` adds `children` only in the output map that wraps each
    // ROOT session; a child is pushed into `directory.children` bare and
    // never re-wrapped. "Normalising" this — giving every node a
    // `children` array — would change 66 nodes' shape in the sidebar, so
    // it is pinned here rather than left to a diff.
    const tree = buildTree([row({ id: "m1" }), row({ id: "c1", parent: "m1" })], roots);
    const child = flatten(tree).find((n) => n.depth === 1).node;
    assert.deepEqual(
      Object.keys(child).sort(),
      ["agent", "id", "kind", "status", "title", "updatedAt"],
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(child, "children"),
      false,
      "a child node must not gain a children key — that is a client-visible shape change",
    );
  });

  test("a leaf ROOT's children is an empty array, not null and not missing", () => {
    const leaf = flatten(buildTree([row({ id: "m1" })], roots))[0].node;
    assert.deepEqual(leaf.children, []);
  });

  test("a null title becomes an empty string", () => {
    const n = flatten(buildTree([row({ id: "m1", title: null })], roots))[0].node;
    assert.equal(n.title, "");
    assert.equal(typeof n.title, "string");
  });
});

describe("buildTree — which rows reach the client (the subagent hierarchy)", () => {
  const W = "/w/proj";
  const W2 = "/w/other";
  const roots = new Map([
    [W, W],
    [W2, W2],
  ]);

  // Table-driven over the boundary cases. `expected` is the set of ids the
  // client actually receives, at the depth it receives them. A row that
  // vanishes is a subagent the user cannot see; a row that arrives at the
  // wrong depth is the same defect. Both are pinned.
  const CASES = [
    {
      name: "a child attaches to its parent at depth 1",
      rows: [row({ id: "m1" }), row({ id: "c1", parent: "m1" })],
      expected: [["m1", 0], ["c1", 1]],
    },
    {
      name: "an orphan (parent not in the row set) is dropped",
      rows: [row({ id: "m1" }), row({ id: "orphan", parent: "gone" })],
      expected: [["m1", 0]],
    },
    {
      name: "a child whose parent is in ANOTHER directory is dropped",
      rows: [row({ id: "m1" }), row({ id: "x", parent: "m1", dir: W2 })],
      expected: [["m1", 0]],
    },
    {
      name: "a grandchild is dropped — only ONE level of subagent renders",
      rows: [row({ id: "m1" }), row({ id: "c1", parent: "m1" }), row({ id: "g1", parent: "c1" })],
      expected: [["m1", 0], ["c1", 1]],
    },
    {
      name: "a child of a `root` container row is dropped",
      rows: [row({ id: "rc", type: "root" }), row({ id: "u", parent: "rc" })],
      expected: [],
    },
    {
      name: "a `root` container row is itself not a sidebar entry",
      rows: [row({ id: "rc", type: "root" }), row({ id: "m1" })],
      expected: [["m1", 0]],
    },
    {
      name: "a self-parenting row is dropped, and does not hang the build",
      rows: [row({ id: "m1" }), row({ id: "self", parent: "self" })],
      expected: [["m1", 0]],
    },
    {
      name: "a two-node cycle is dropped and does not hang the build",
      rows: [row({ id: "m1" }), row({ id: "a", parent: "b" }), row({ id: "b", parent: "a" })],
      expected: [["m1", 0]],
    },
    {
      name: "several children of one parent all render, sorted by recency",
      rows: [
        row({ id: "m1" }),
        row({ id: "old", parent: "m1", at: 1 }),
        row({ id: "new", parent: "m1", at: 9 }),
      ],
      expected: [["m1", 0], ["new", 1], ["old", 1]],
    },
  ];

  for (const { name, rows, expected } of CASES) {
    test(name, () => {
      assert.deepEqual(visible(buildTree(rows, roots)), expected);
    });
  }

  test("the depth distribution is exactly two levels for a main+subagent+deeper shape", () => {
    // The "层深分布" the batch brief asks to be compared: whatever the db
    // holds, the client never sees deeper than depth 1.
    const rows = [
      row({ id: "m1" }),
      row({ id: "m2" }),
      row({ id: "c1", parent: "m1" }),
      row({ id: "g1", parent: "c1" }),
      row({ id: "g2", parent: "g1" }),
      row({ id: "orphan", parent: "nope" }),
    ];
    const hist = {};
    for (const n of flatten(buildTree(rows, roots))) {
      hist[n.depth] = (hist[n.depth] || 0) + 1;
    }
    assert.deepEqual(hist, { 0: 2, 1: 1 });
  });
});

describe("buildTree — title and field boundaries", () => {
  const roots = new Map([["/w/proj", "/w/proj"]]);

  // Table-driven: [name, title, expected]. A title travels into both export
  // formats and into the sidebar label, so special characters, newlines and
  // absurd lengths must survive verbatim rather than be normalised.
  const TITLES = [
    ["plain", "普通标题", "普通标题"],
    ["quotes and backslash", 'a"b\\c', 'a"b\\c'],
    ["html-ish", "<script>alert(1)</script>&amp;", "<script>alert(1)</script>&amp;"],
    ["multi-line", "第一行\n第二行\r\n第三行\t制表", "第一行\n第二行\r\n第三行\t制表"],
    ["emoji and rtl", "🚀 עברית مرحبا", "🚀 עברית مرحبا"],
    ["§§ marker-looking", "§§ turn_msg=abc", "§§ turn_msg=abc"],
    ["very long", "长".repeat(5000), "长".repeat(5000)],
    ["empty", "", ""],
    ["null becomes empty", null, ""],
    ["only whitespace", "   ", "   "],
  ];

  for (const [name, title, expected] of TITLES) {
    test(`title: ${name}`, () => {
      const n = flatten(buildTree([row({ id: "m1", title })], roots))[0].node;
      assert.equal(n.title, expected);
    });
  }

  // A row that states ONLY the columns it must — no defaulting helper, so
  // a column really is absent rather than filled in with a placeholder.
  // `buildTree` reads `row.agent_name || ""`, `row.session_kind || ""`,
  // `row.status || ""` and `row.updated_at_ms ?? 0`, so absent and
  // empty-string collapse to the same node value; `updated_at_ms` is the
  // one that distinguishes missing (0) from falsy-but-present.
  const bare = (o) => ({
    session_id: o.id,
    parent_session_id: o.parent ?? null,
    session_type: o.type ?? "branch",
    workspace_dir: o.dir ?? "/w/proj",
    ...o.extra,
  });

  // Table-driven: [name, bare-row, field, expected].
  const FIELDS = [
    ["agent_name absent → empty string", bare({ id: "m1" }), "agent", ""],
    ["agent_name empty → empty string", bare({ id: "m1", extra: { agent_name: "" } }), "agent", ""],
    ["agent_name present", bare({ id: "m1", extra: { agent_name: "coder" } }), "agent", "coder"],
    ["session_kind absent → empty string", bare({ id: "m1" }), "kind", ""],
    ["session_kind task", bare({ id: "m1", extra: { session_kind: "task" } }), "kind", "task"],
    ["status absent → empty string", bare({ id: "m1" }), "status", ""],
    ["status running", bare({ id: "m1", extra: { status: "running" } }), "status", "running"],
    ["updated_at_ms absent → 0", bare({ id: "m1" }), "updatedAt", 0],
    ["updated_at_ms 0 stays 0", bare({ id: "m1", extra: { updated_at_ms: 0 } }), "updatedAt", 0],
    ["title absent → empty string", bare({ id: "m1" }), "title", ""],
    ["title null → empty string", bare({ id: "m1", extra: { title: null } }), "title", ""],
  ];

  for (const [name, r, field, expected] of FIELDS) {
    test(name, () => {
      assert.equal(flatten(buildTree([r], roots))[0].node[field], expected);
    });
  }
});

describe("buildTree — empty and single-session inputs", () => {
  const roots = new Map([["/w/proj", "/w/proj"]]);

  test("no rows at all → an empty project list, not null and not a throw", () => {
    assert.deepEqual(buildTree([], roots), []);
  });

  test("a single main session → one project, one directory, one session", () => {
    const tree = buildTree([row({ id: "m1" })], roots);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].directories.length, 1);
    assert.equal(tree[0].directories[0].sessions.length, 1);
    assert.equal(tree[0].sessionCount, 1);
  });

  test("a single main session with children reports sessionCount 1, not 3", () => {
    // The project pill counts user-started sessions; subagents must not
    // inflate it. Pinned because it is easy to "fix" by accident.
    const tree = buildTree(
      [row({ id: "m1" }), row({ id: "c1", parent: "m1" }), row({ id: "c2", parent: "m1" })],
      roots,
    );
    assert.equal(tree[0].sessionCount, 1);
    assert.equal(tree[0].directories[0].sessions[0].children.length, 2);
  });

  test("only orphan rows → no sessions, but the directory still appears", () => {
    const tree = buildTree([row({ id: "o1", parent: "gone" })], roots);
    assert.equal(tree.length, 1, "the directory is a grouping key even with no visible session");
    assert.deepEqual(tree[0].directories[0].sessions, []);
    assert.equal(tree[0].sessionCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. The facade: forwarding, verbatim, against a real db
// ---------------------------------------------------------------------------

describe("readEngineSessionTree — forwards the payload verbatim", () => {
  test("the result carries the tree plus source/gate/transport", async () => {
    const { tree, source, gate, transport } = await readEngineSessionTree({ force: true });
    assert.equal(tree.ok, true);
    assert.equal(source, "runtime-db", "the tree is not a transport-switched surface");
    assert.equal(gate.endpoint, ENDPOINT);
    assert.equal(typeof transport, "string");
    assert.deepEqual(Object.keys(tree).sort(), [
      "cached",
      "counts",
      "generatedAt",
      "ok",
      "projects",
      "truncated",
    ]);
  });

  test("the forwarded tree is the 1-level shape buildTree produces", async () => {
    // The fixture db carries 25 seeded rows; the SQL WHERE clause drops the
    // 5 filtered ones, and the hierarchy filter drops the orphan, the
    // grandchild, the cross-directory child, the two cycle rows, the
    // self-parent, the `root` container and its child. Only main sessions
    // and their direct children may appear.
    const { tree } = await readEngineSessionTree({ force: true });
    const ids = visible(tree.projects).map(([id]) => id);
    assert.ok(!ids.includes("orphan"), "an orphan must not reach the client");
    assert.ok(!ids.includes("g1"), "a grandchild must not reach the client");
    assert.ok(!ids.includes("xd"), "a cross-directory child must not reach the client");
    assert.ok(!ids.includes("cyc-a") && !ids.includes("cyc-b"), "cycle rows must not reach the client");
    assert.ok(!ids.includes("rc") && !ids.includes("under-rc"), "container rows must not reach the client");
    assert.ok(!ids.includes("f-archived"), "archived rows are filtered by SQL");
    assert.ok(!ids.includes("f-peek"), "peek rows are filtered by SQL");
    assert.ok(!ids.includes("f-nodir"), "rows without a directory are filtered by SQL");
    // Exactly two depths, and the children hang off m1.
    const depths = new Set(visible(tree.projects).map(([, d]) => d));
    assert.deepEqual([...depths].sort(), [0, 1]);
    const m1 = flatten(tree.projects).find((n) => n.id === "m1");
    assert.deepEqual(m1.node.children.map((c) => c.id).sort(), ["c1", "c2"]);
    assert.equal(tree.truncated, false, "a small fixture never truncates");
  });

  test("a custom title from the webui store overlays the db title", async () => {
    // `customTitles` only exists on the webui record, so without the
    // overlay the sidebar would keep showing whatever mcode generated.
    const { tree } = await readEngineSessionTree({ force: true });
    const m1 = flatten(tree.projects).find((n) => n.id === "m1");
    assert.equal(m1.node.title, "改过名的主会话");
    const c1 = flatten(tree.projects).find((n) => n.id === "c1");
    assert.equal(c1.node.title, "子 agent", "titleCustom:false must NOT overlay");
  });

  test("force:false reuses the 15s cache and reports cached:true", async () => {
    const first = await readEngineSessionTree({ force: true });
    assert.equal(first.tree.cached, false);
    const second = await readEngineSessionTree({ force: false });
    assert.equal(second.tree.cached, true, "the facade forwards the cache flag, it does not bypass the cache");
  });
});

// ---------------------------------------------------------------------------
// 5. The route: pass-through, and the 501 that must NOT be swallowed
// ---------------------------------------------------------------------------

describe("handleSessionTree — the route passes the facade payload through", () => {
  // One fresh route module per test. node:test's `mock.module` re-evaluates
  // the MOCKED specifier, but a route module already sitting in the registry
  // keeps its old live binding to the facade — so the second and third tests
  // in this suite would silently exercise the FIRST test's mock and pass for
  // the wrong reason. The `?bust=N` query makes the route re-resolve the
  // facade specifier, which is what picks up the new mock. (These tests need
  // the `--experimental-test-module-mocks` flag that the `test:unit` and
  // `test` scripts already pass.)
  //
  // A mutation that deletes the `?bust=N` from this suite's re-import turns
  // NINE of its tests red at once; that is the cheapest proof the mechanism
  // is load-bearing rather than decorative.
  let bust = 0;

  test("a facade payload is written to the response byte-for-byte", async (t) => {
    // The payload is injected rather than produced, so this is about the
    // ROUTE's contract: it must not re-shape, re-count or re-derive
    // anything. The payload carries the exact key set the real tree
    // produces, `cached` included.
    const payload = {
      ok: true,
      generatedAt: 1750000000000,
      truncated: false,
      counts: { projects: 1, directories: 1, sessions: 2 },
      projects: [
        {
          key: "proj",
          name: "proj",
          repoPaths: ["/w/proj"],
          latestAt: 1000,
          sessionCount: 1,
          directories: [
            {
              path: "/w/proj",
              name: "proj",
              latestAt: 1000,
              sessions: [
                {
                  id: "m1",
                  title: "主会话",
                  agent: "",
                  kind: "conversation",
                  status: "idle",
                  updatedAt: 1000,
                  children: [
                    {
                      id: "c1",
                      title: "子 agent",
                      agent: "coder",
                      kind: "task",
                      status: "running",
                      updatedAt: 900,
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      cached: false,
    };
    await setupMocks(t, { acp: {} });
    t.mock.module(absPath("engine/session-tree-reads.js"), {
      namedExports: {
        readEngineSessionTree: async () => ({
          tree: payload,
          source: "runtime-db",
          gate: { endpoint: ENDPOINT, gate: "checked" },
          transport: "acp",
        }),
      },
    });
    const sessionsRoute = await import(`${absPath("routes/sessions.js")}?bust=${bust++}`);
    const written = [];
    const res = {
      headersSent: false,
      writeHead(status, headers) { written.push({ status, headers }); this.headersSent = true; return this; },
      end(body) { written.push({ body }); return this; },
    };
    await sessionsRoute.handleSessionTree({ url: "/api/session-tree" }, res, { cid: "t" });
    assert.equal(written[0].status, 200);
    assert.equal(written[0].headers["Cache-Control"], "no-store");
    assert.deepEqual(JSON.parse(written[1].body), payload);
  });

  test("?refresh=1 reaches the facade as force:true, and nothing else does", async (t) => {
    await setupMocks(t, { acp: {} });
    const seen = [];
    t.mock.module(absPath("engine/session-tree-reads.js"), {
      namedExports: {
        readEngineSessionTree: async (o) => {
          seen.push(o);
          return { tree: { ok: true }, source: "runtime-db", gate: {}, transport: "acp" };
        },
      },
    });
    const sessionsRoute = await import(`${absPath("routes/sessions.js")}?bust=${bust++}`);
    const mk = () => ({
      headersSent: false,
      writeHead() { this.headersSent = true; return this; },
      end() { return this; },
    });
    // Table-driven: [query, expected force]. The limit/offset/page/cursor
    // rows are the measured contract, not an assumption — #8 never read
    // them, and adding a clamp here would invent behaviour.
    const QUERIES = [
      ["?refresh=1", true],
      ["", false],
      ["?refresh=0", false],
      ["?refresh=true", false],
      ["?limit=1", false],
      ["?limit=0", false],
      ["?limit=999999", false],
      ["?offset=5", false],
      ["?page=2", false],
      ["?cursor=x", false],
      ["?limit=1&refresh=1", true],
    ];
    for (const [q] of QUERIES) {
      await sessionsRoute.handleSessionTree({ url: `/api/session-tree${q}` }, mk(), { cid: "t" });
    }
    assert.equal(seen.length, QUERIES.length);
    for (let i = 0; i < QUERIES.length; i += 1) {
      assert.equal(seen[i].force, QUERIES[i][1], `query "${QUERIES[i][0]}" → force=${QUERIES[i][1]}`);
    }
  });

  test("a capability error PROPAGATES so invokeHandler can answer 501", async (t) => {
    // The one place this batch could have turned a 501 into a 200: the
    // route's try/catch would fold the gate error into its own
    // `{ok:false, reason:"session_tree_failed"}` body. It must not — the
    // declaration gate is the whole point of the batch.
    await setupMocks(t, { acp: {} });
    t.mock.module(absPath("engine/session-tree-reads.js"), {
      namedExports: {
        readEngineSessionTree: async () => {
          throw new EngineCapabilityNotSupportedError({
            capability: "sessionCrud",
            provider: "fixture-provider",
            missing: ["listSessions"],
            reason: "test fixture: interface-absent",
          });
        },
      },
    });
    const sessionsRoute = await import(`${absPath("routes/sessions.js")}?bust=${bust++}`);
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true; return this; },
      end() { return this; },
    };
    await assert.rejects(
      () => sessionsRoute.handleSessionTree({ url: "/api/session-tree" }, res, { cid: "t" }),
      isEngineCapabilityNotSupportedError,
    );
  });

  test("a LOOKALIKE error that merely carries the right .name does NOT propagate", async (t) => {
    // The route discriminates with `isEngineCapabilityNotSupportedError`
    // (an `instanceof` check), not with `cause.name === "…"`. `.name` is a
    // writable instance property, so any code upstream can make an ordinary
    // error impersonate the gate's — and a `.name` compare would then
    // re-throw it and turn a soft-fail into a 501 the engine never
    // declared. Pinned as a pair with the test above: the real class
    // propagates, the impersonator does not.
    await setupMocks(t, { acp: {} });
    const lookalike = new Error("not the gate");
    lookalike.name = "EngineCapabilityNotSupportedError";
    t.mock.module(absPath("engine/session-tree-reads.js"), {
      namedExports: { readEngineSessionTree: async () => { throw lookalike; } },
    });
    const sessionsRoute = await import(`${absPath("routes/sessions.js")}?bust=${bust++}`);
    const written = [];
    const res = {
      headersSent: false,
      writeHead(s, h) { written.push({ s, h }); this.headersSent = true; return this; },
      end(b) { written.push({ b }); return this; },
    };
    // Must NOT reject: an impostor is an ordinary failure and degrades.
    await sessionsRoute.handleSessionTree({ url: "/api/session-tree" }, res, { cid: "t" });
    assert.equal(written[0].s, 200, "an impostor must not become a 501");
    const body = JSON.parse(written[1].b);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "session_tree_failed");
    assert.equal(body.detail, "not the gate");
  });

  test("a NON-capability failure still degrades to ok:false + reason", async (t) => {
    // The soft-fail contract for a broken tree read is unchanged: 200 with
    // `{ok:false, reason:"session_tree_failed"}`.
    await setupMocks(t, { acp: {} });
    t.mock.module(absPath("engine/session-tree-reads.js"), {
      namedExports: {
        readEngineSessionTree: async () => {
          throw new Error("boom");
        },
      },
    });
    const sessionsRoute = await import(`${absPath("routes/sessions.js")}?bust=${bust++}`);
    const written = [];
    const res = {
      headersSent: false,
      writeHead(s, h) { written.push({ s, h }); this.headersSent = true; return this; },
      end(b) { written.push({ b }); return this; },
    };
    await sessionsRoute.handleSessionTree({ url: "/api/session-tree" }, res, { cid: "t" });
    assert.equal(written[0].s, 200);
    const body = JSON.parse(written[1].b);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "session_tree_failed");
    assert.equal(body.detail, "boom");
  });
});
