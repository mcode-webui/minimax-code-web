// webui/test/routes/session-reads.check.mjs
//
// M3-B1: the five directory-read endpoints, driven end to end.
//
// Why this file exists. Batch B1 moved #9, #10, #72, #74 and #75 behind
// the engine facade (server/engine/session-reads.js). The move is only
// allowed to be invisible, and "invisible" has exactly two failure modes
// worth a test:
//
//   - the SIDEBAR (#9, #72) and the /api/state FIRST FRAME (#74) are
//     render contracts. A field added here, a `null` turned into `[]`, an
//     `updatedAt` that stopped being a string — all invisible in a diff,
//     all a broken render. The shape tables below are the net.
//
//   - the endpoints must keep answering the SAME status codes and error
//     bodies they answered before the gate went in. A 501 that used to be a
//     200 for a session that plainly exists is a regression the facade
//     introduced, not a degradation it disclosed.
//
// Style follows the existing route suites (test/routes/sessions.check.mjs,
// test/routes/health.check.mjs): setupMocks + registerAcpMock, handlers
// imported dynamically after the mocks are registered.
//
// The suite is transport-agnostic by construction: it asserts the RULE for
// whichever MCODE_WEBUI_TRANSPORT the run was started with, which is why
// the batch's gate runs it under both `acp` and `runtime`.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  setupMocks,
  absPath,
  registerAcpMock,
  acpMock,
} from "../helpers/_setup.js";

let handleAcpSessions, handleAcpSessionTitle, handleListSessions, handleState, handleHealth;
let makeClientState, clients, sbMock;

function fakeRes() {
  return {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      this._headers = h || null;
    },
    end(b) {
      this._body = b;
    },
  };
}

async function readJson(res) {
  return JSON.parse(res._body);
}

before(async (t) => {
  await setupMocks(t, { mavis: { applyMavisUsageToCs: async () => {} } });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  const sessions = await import(absPath("routes/sessions.js"));
  handleAcpSessions = sessions.handleAcpSessions;
  handleAcpSessionTitle = sessions.handleAcpSessionTitle;
  const protocol = await import(absPath("routes/protocol.js"));
  handleListSessions = protocol.handleListSessions;
  const state = await import(absPath("routes/state.js"));
  handleState = state.handleState;
  const health = await import(absPath("routes/health.js"));
  handleHealth = health.handleHealth;
  void sbMock;
});

// One ACP-wire session entry, exactly the projection
// `lib/catalogue-sessions.js#projectTuiSessionToAcp` emits: `sessionId` and
// `cwd` always, `title` only when non-empty, `updatedAt` only when a finite
// timestamp exists. Both optional keys are load-bearing for the sidebar: an
// entry that suddenly carries `title: null` renders a blank row.
const WIRE_SESSION = {
  sessionId: "mvs_aaaa1111222233334444555566667777",
  cwd: "/ws/a",
  title: "Engine generated title",
  updatedAt: "2026-10-03T00:00:00.000Z",
};
const WIRE_SESSION_BARE = { sessionId: "mvs_bbbb", cwd: "/ws/a" };

beforeEach(() => {
  clients.clear();
  registerAcpMock({
    listAllMcodeSessions: async () => [],
    getMcodeSessionsForWorkspace: async () => [],
    getMcodeSessionTitle: async () => null,
    getMcodeServerInfo: () => null,
    getCatalogueHost: async () => null,
    getCachedMcodeCommands: () => [],
    getMcodeSessionsCacheSync: () => null,
    getMcodeSessionsStaleSync: () => null,
  });
  const cs = makeClientState();
  cs.workspace = { dir: "/ws/a", branch: null, tree: null };
  clients.set("cid-1", cs);
});

// ---------------------------------------------------------------------------
// #9 GET /api/acp-sessions
// ---------------------------------------------------------------------------

describe("#9 GET /api/acp-sessions — sidebar list shape", () => {
  // Table-driven: [name, engineAnswer, expectedFieldLists]. `expectedFieldLists`
  // is one expected key order per returned entry, so a normalizer that
  // started emitting an extra key (or dropping `updatedAt`) fails the row
  // that produced it, not some unrelated one.
  const CASES = [
    ["a fully-populated entry", [WIRE_SESSION], [["sessionId", "cwd", "title", "updatedAt"]]],
    ["an entry with the optional keys absent", [WIRE_SESSION_BARE], [["sessionId", "cwd"]]],
    ["a mixed list keeps per-entry shapes", [WIRE_SESSION, WIRE_SESSION_BARE], [
      ["sessionId", "cwd", "title", "updatedAt"],
      ["sessionId", "cwd"],
    ]],
  ];

  for (const [name, engineAnswer, expectedFieldLists] of CASES) {
    test(name, async () => {
      registerAcpMock({ getMcodeSessionsForWorkspace: async () => engineAnswer });
      const res = fakeRes();
      await handleAcpSessions(
        { url: "/api/acp-sessions?cwd=%2Fws%2Fa" },
        res,
        { cs: clients.get("cid-1"), cid: "cid-1", pathname: "/api/acp-sessions" },
      );
      assert.equal(res._status, 200);
      const body = await readJson(res);
      assert.equal(body.cwd, "/ws/a");
      assert.deepEqual(Object.keys(body), ["ok", "cwd", "sessions"]);
      assert.deepEqual(body.sessions.map((s) => Object.keys(s)), expectedFieldLists);
    });
  }

  test("no sessions answers [], never null", async () => {
    registerAcpMock({ getMcodeSessionsForWorkspace: async () => [] });
    const res = fakeRes();
    await handleAcpSessions(
      { url: "/api/acp-sessions?cwd=%2Fws%2Fa" },
      res,
      { cs: clients.get("cid-1"), cid: "cid-1", pathname: "" },
    );
    const body = await readJson(res);
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions.length, 0);
  });

  test("updatedAt stays an ISO string, never an epoch number", async () => {
    registerAcpMock({ getMcodeSessionsForWorkspace: async () => [WIRE_SESSION] });
    const res = fakeRes();
    await handleAcpSessions(
      { url: "/api/acp-sessions?cwd=%2Fws%2Fa" },
      res,
      { cs: clients.get("cid-1"), cid: "cid-1", pathname: "" },
    );
    const { sessions } = await readJson(res);
    assert.equal(typeof sessions[0].updatedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(sessions[0].updatedAt)));
  });

  test("no ?cwd falls back to cs.workspace.dir", async () => {
    const res = fakeRes();
    await handleAcpSessions(
      { url: "/api/acp-sessions" },
      res,
      { cs: clients.get("cid-1"), cid: "cid-1", pathname: "" },
    );
    assert.equal((await readJson(res)).cwd, "/ws/a");
  });

  test("an empty ?cwd with no workspace answers the empty string, and no filter is applied", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: null, branch: null, tree: null };
    registerAcpMock({ getMcodeSessionsForWorkspace: async () => [WIRE_SESSION] });
    const res = fakeRes();
    await handleAcpSessions({ url: "/api/acp-sessions?cwd=" }, res, { cs, cid: "c", pathname: "" });
    const body = await readJson(res);
    assert.equal(body.cwd, "");
    // An empty cwd means "no filter" — the endpoint hands the empty string
    // to the client and the client answers with everything. Shrinking this
    // to the current workspace would silently empty the remote-control UI.
    assert.equal(body.sessions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #10 GET /api/acp-session-title
// ---------------------------------------------------------------------------

describe("#10 GET /api/acp-session-title — title shape", () => {
  // Table-driven on the ENGINE answer and the WIRE answer. The `|| null` in
  // the handler is the rule: "", undefined and "no such session" all reach
  // the client as `title: null`, never as "" and never as a missing key.
  const CASES = [
    ["a titled session", "mvs_1", "My Title", "My Title"],
    ["an untitled session", "mvs_1", null, null],
    ["an empty title", "mvs_1", "", null],
    ["an undefined title", "mvs_1", undefined, null],
  ];

  for (const [name, sid, engineAnswer, wireTitle] of CASES) {
    test(name, async () => {
      registerAcpMock({ getMcodeSessionTitle: async () => engineAnswer });
      const res = fakeRes();
      await handleAcpSessionTitle(
        { url: `/api/acp-session-title?sessionId=${sid}` },
        res,
        {},
      );
      assert.equal(res._status, 200);
      const body = await readJson(res);
      assert.deepEqual(Object.keys(body), ["ok", "sessionId", "title"]);
      assert.equal(body.sessionId, sid);
      assert.equal(body.title, wireTitle);
    });
  }

  // The 400 is unchanged by the batch: the gate sits behind the parameter
  // check, so a missing sessionId is still a client error and never a 501.
  test("a missing sessionId is still 400 {ok:false,error}, not 501", async () => {
    const res = fakeRes();
    await handleAcpSessionTitle({ url: "/api/acp-session-title" }, res, {});
    assert.equal(res._status, 400);
    const body = await readJson(res);
    assert.deepEqual(body, { ok: false, error: "sessionId required" });
  });

  test("an empty sessionId is still 400", async () => {
    const res = fakeRes();
    await handleAcpSessionTitle({ url: "/api/acp-session-title?sessionId=" }, res, {});
    assert.equal(res._status, 400);
  });
});

// ---------------------------------------------------------------------------
// #72 GET /api/protocol/list-sessions
// ---------------------------------------------------------------------------

describe("#72 GET /api/protocol/list-sessions — remote-control list shape", () => {
  const CASES = [
    ["one entry", [WIRE_SESSION], [["sessionId", "cwd", "title", "updatedAt"]]],
    ["an entry with the optional keys absent", [WIRE_SESSION_BARE], [["sessionId", "cwd"]]],
  ];

  for (const [name, engineAnswer, expectedFieldLists] of CASES) {
    test(name, async () => {
      registerAcpMock({ listAllMcodeSessions: async () => engineAnswer });
      const res = fakeRes();
      await handleListSessions(
        { url: "/api/protocol/list-sessions?cwd=%2Fws%2Fa" },
        res,
        { cs: clients.get("cid-1"), cid: "cid-1" },
      );
      assert.equal(res._status, 200);
      const body = await readJson(res);
      assert.deepEqual(Object.keys(body), ["ok", "sessions", "cwd"]);
      assert.deepEqual(body.sessions.map((s) => Object.keys(s)), expectedFieldLists);
    });
  }

  // The cwd filter is the route's own and its shape differs from #9's: an
  // unfiltered read answers WITHOUT the `cwd` key at all, a filtered read
  // answers WITH it. Both are load-bearing for the remote-control UI.
  test("an empty cwd answers without the cwd key and without filtering", async () => {
    registerAcpMock({ listAllMcodeSessions: async () => [WIRE_SESSION] });
    const res = fakeRes();
    await handleListSessions(
      { url: "/api/protocol/list-sessions" },
      res,
      { cs: { workspace: { dir: null } }, cid: "c" },
    );
    const body = await readJson(res);
    assert.deepEqual(Object.keys(body), ["ok", "sessions"]);
    assert.equal(body.sessions.length, 1);
  });

  test("the cwd filter is case- and slash-insensitive, and drops other workspaces", async () => {
    registerAcpMock({
      listAllMcodeSessions: async () => [
        WIRE_SESSION,
        { sessionId: "mvs_cccc", cwd: "/ws/other" },
        { sessionId: "mvs_dddd", cwd: "/WS/A/" },
      ],
    });
    const res = fakeRes();
    await handleListSessions(
      { url: "/api/protocol/list-sessions?cwd=%2Fws%2Fa" },
      res,
      { cs: clients.get("cid-1"), cid: "cid-1" },
    );
    const body = await readJson(res);
    assert.deepEqual(
      body.sessions.map((s) => s.sessionId),
      ["mvs_aaaa1111222233334444555566667777", "mvs_dddd"],
    );
  });

  test("no sessions answers [], never null", async () => {
    registerAcpMock({ listAllMcodeSessions: async () => [] });
    const res = fakeRes();
    await handleListSessions(
      { url: "/api/protocol/list-sessions?cwd=%2Fws%2Fa" },
      res,
      { cs: clients.get("cid-1"), cid: "cid-1" },
    );
    const body = await readJson(res);
    assert.deepEqual(body.sessions, []);
  });
});

// ---------------------------------------------------------------------------
// #74 GET /api/state — the first-frame render contract
// ---------------------------------------------------------------------------

describe("#74 GET /api/state — snapshot first frame", () => {
  // The first frame IS the frontend's render contract (red line in
  // doc/m3-batch-plan.md §5), so the field list is pinned literally —
  // order included, because the sidebar merges these positionally in some
  // views. The first 18 keys are `makeClientState()`'s own client state,
  // spread verbatim by the route; the last 9 are the route's additions,
  // and `sessions` is the position `makeClientState()` gave it even though
  // the route overwrites its value with the chat-stripped projection.
  const BASELINE_FIELDS = [
    "version",
    "workspace",
    "model",
    "sessionId",
    "mcodeSessionId",
    "sessionTitle",
    "lastUsedWorkspace",
    "context",
    "usage",
    "permissions",
    "chat",
    "sessions",
    "goal",
    "todo",
    "ask",
    "plan",
    "running",
    "recentSubagents",
    "mcodeSessions",
    "availableCommands",
    "lanBroadcast",
    "readOnly",
    "tokenEnabled",
    "currentToken",
    "tokenAcknowledged",
    "tokenRotatedAt",
    "revision",
  ];

  test("the snapshot field list is exactly the baseline — none added, none removed, same order", async () => {
    const res = fakeRes();
    await handleState({ url: "/api/state" }, res, { cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = await readJson(res);
    assert.deepEqual(Object.keys(body), BASELINE_FIELDS);
  });

  test("every baseline field is present, so a reordering cannot hide a removal", async () => {
    const res = fakeRes();
    await handleState({ url: "/api/state" }, res, { cid: "cid-1" });
    const body = await readJson(res);
    for (const field of BASELINE_FIELDS) {
      assert.ok(field in body, `snapshot must still carry "${field}"`);
    }
  });

  test("mcodeSessions is the engine's workspace-filtered list, entry for entry", async () => {
    registerAcpMock({ getMcodeSessionsForWorkspace: async () => [WIRE_SESSION] });
    const res = fakeRes();
    await handleState({ url: "/api/state" }, res, { cid: "cid-1" });
    const body = await readJson(res);
    assert.deepEqual(body.mcodeSessions, [WIRE_SESSION]);
    assert.deepEqual(
      body.mcodeSessions.map((s) => Object.keys(s)),
      [["sessionId", "cwd", "title", "updatedAt"]],
    );
  });

  test("an engine with no sessions answers mcodeSessions: [] — not null, not missing", async () => {
    registerAcpMock({ getMcodeSessionsForWorkspace: async () => [] });
    const res = fakeRes();
    await handleState({ url: "/api/state" }, res, { cid: "cid-1" });
    const body = await readJson(res);
    assert.ok(Array.isArray(body.mcodeSessions));
    assert.deepEqual(body.mcodeSessions, []);
  });

  // The local webui session list rides in the same payload under
  // `sessions` and is stripped of `chat`; the engine mirror rides in
  // `mcodeSessions`. Swapping the two would render the sidebar from the
  // wrong source while every individual field still looked right.
  test("the local session list and the engine mirror are separate keys", async () => {
    registerAcpMock({ getMcodeSessionsForWorkspace: async () => [WIRE_SESSION] });
    const res = fakeRes();
    await handleState({ url: "/api/state" }, res, { cid: "cid-1" });
    const body = await readJson(res);
    assert.ok(Array.isArray(body.sessions));
    assert.ok(Array.isArray(body.mcodeSessions));
    assert.notDeepEqual(body.sessions, body.mcodeSessions);
  });

  test("revision is a number and advances per read (the SSE monotonic contract)", async () => {
    const first = fakeRes();
    await handleState({ url: "/api/state" }, first, { cid: "cid-1" });
    const second = fakeRes();
    await handleState({ url: "/api/state" }, second, { cid: "cid-1" });
    const a = await readJson(first);
    const b = await readJson(second);
    assert.equal(typeof a.revision, "number");
    assert.ok(b.revision > a.revision, "each /api/state read bumps the per-cid revision");
  });
});

// ---------------------------------------------------------------------------
// #75 GET /api/health
// ---------------------------------------------------------------------------

describe("#75 GET /api/health — version source", () => {
  // Table-driven: [name, agentInfo, expected]. The facade is a pass-through
  // for the agentInfo mirror, and the sentinel for "nothing attached" stays
  // the string "unknown" — a null here breaks every semver-parsing monitor.
  const CASES = [
    ["an attached client reports its version", { name: "mcode", version: "0.5.7" }, "0.5.7"],
    ["a client with no version field reports unknown", { name: "mcode" }, "unknown"],
    ["no client at all reports unknown", null, "unknown"],
  ];

  for (const [name, info, expected] of CASES) {
    test(name, async () => {
      registerAcpMock({ getMcodeServerInfo: () => info });
      const res = fakeRes();
      await handleHealth(null, res);
      assert.equal(res._status, 200);
      const body = await readJson(res);
      assert.equal(body.mcodeVersion, expected);
      assert.equal(typeof body.mcodeVersion, "string");
    });
  }

  test("the health payload is still exactly seven keys", async () => {
    const res = fakeRes();
    await handleHealth(null, res);
    const body = await readJson(res);
    assert.deepEqual(Object.keys(body), [
      "ok",
      "port",
      "defaultModel",
      "defaultWorkspace",
      "mcodeCmd",
      "mcodeVersion",
      "maxConcurrent",
    ]);
  });
});
