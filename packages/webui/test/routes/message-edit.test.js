// webui/test/routes/message-edit.test.js
// The message-level edit / rewind family (PB-15, plan
// `doc/placeholder-batch-plan.md` §7 row G-3) — the two destructive writes
// a user makes when the message they already sent was the wrong message.
//
// Hermetic by construction: both handlers take an optional fourth argument
// that reaches the engine facade's `getHost` seam, so these tests drive a
// fake `host.cliService` — no runtime boot, no network, no temporary
// directory, no spawned server.
//
// SEVEN invariants, in the order they matter:
//
//   1. THE SESSION ID NEVER COMES FROM THE BODY. Both routes read it from
//      `ctx.cs.mcodeSessionId`. A body that names a different session is
//      ignored, not obeyed: these calls delete history, and "which
//      conversation" is the one question the caller must not get to answer.
//   2. NOTHING IS CALLED WHEN VALIDATION FAILS. A wrong-typed or missing
//      message id must be refused BEFORE the host is resolved — a test that
//      only asserted the status would miss that `editSessionMessage` was
//      reached anyway.
//   3. THE ENGINE DECIDES `rewound`, THE SERVER DOES NOT INVENT IT. Both
//      endpoints project `rewound` as the engine reported it. A 200 with
//      `rewound:false` stays a 200 with `rewound:false`, because that is
//      the engine's answer.
//   4. THE FILE OUTCOME IS REPORTED, NOT SWALLOWED. A rewind that restored
//      nothing (`turnDiffRewind:null`, or a status with an `errorCode`) is
//      passed through as such. Collapsing it into a boolean would let the
//      client describe a workspace the engine never restored.
//   5. AN ENGINE REFUSAL KEEPS ITS STATUS AND ITS MESSAGE. The engine
//      answers 409/400/501 with a reason; the route forwards both rather
//      than flattening them into a 500 the user cannot act on.
//   6. `clientRequestId` IS SERVER-MINTED AND FRESH. The engine requires
//      one; a browser-minted engine identifier arriving from an untrusted
//      boundary buys nothing here.
//   7. `rewindTurnDiff` IS ON. Discarding a turn and keeping the files it
//      wrote would leave the workspace describing a conversation that no
//      longer exists — the same choice the TUI's own edit/rewind calls make.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const route = await import(absPath("routes/message-edit.js"));
const engine = await import(absPath("engine/message-edit.js"));
const absFile = (rel) => join(import.meta.dirname, "..", "..", "server", rel);

const SESSION = "mvs_session_for_message_edit";
const OTHER_SESSION = "mvs_some_other_session";

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  return {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
}

function bodyReq(payload) {
  return Readable.from([
    Buffer.from(payload === undefined ? "" : JSON.stringify(payload), "utf8"),
  ]);
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body);
}

const ctx = (sessionId) => ({ cid: "c", cs: { mcodeSessionId: sessionId } });

/** A fake `host.cliService` that records every call it receives. */
function fakeHost(overrides = {}) {
  const calls = [];
  const host = {
    calls,
    cliService: {
      editSessionMessage: async (req) => {
        calls.push(["editSessionMessage", req]);
        return { rewound: true, turnId: "turn_2", userMessageId: req.userMessageId, deletedMessageIds: ["m1", "m2"] };
      },
      rewindSession: async (req) => {
        calls.push(["rewindSession", req]);
        return {
          rewound: true,
          deletedMessageIds: ["m1"],
          turnDiffRewind: { status: "reverted", revertedTurnIds: ["turn_1"] },
        };
      },
      ...overrides,
    },
  };
  const getHost = async () => {
    calls.push(["getHost"]);
    return host;
  };
  return { host, getHost, calls };
}

const ID = { userMessageId: "msg_user_7" };
const okHost = () => fakeHost();

describe("POST /api/messages/edit", () => {
  test("answers the engine's own answer, with the server's session id", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageEdit(
      bodyReq({ ...ID, content: "the corrected text" }),
      res,
      ctx(SESSION),
      { getHost },
    );
    const body = await readBody(res);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.rewound, true);
    assert.equal(body.turnId, "turn_2");
    assert.equal(body.deletedCount, 2);
    const call = calls.find(([name]) => name === "editSessionMessage");
    assert.equal(call[1].id, SESSION);
    assert.equal(call[1].userMessageId, "msg_user_7");
    assert.equal(call[1].content, "the corrected text");
  });

  test("ignores a session id in the body", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    await route.handleMessageEdit(
      bodyReq({ ...ID, content: "x", sessionId: OTHER_SESSION, id: OTHER_SESSION }),
      res,
      ctx(SESSION),
      { getHost },
    );
    await readBody(res);
    const call = calls.find(([name]) => name === "editSessionMessage");
    assert.equal(call[1].id, SESSION);
  });

  test("mints a fresh clientRequestId per call and never takes one from the body", async () => {
    const { getHost, calls } = okHost();
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes();
      await route.handleMessageEdit(
        bodyReq({ ...ID, content: "x", clientRequestId: "attacker-chosen" }),
        res,
        ctx(SESSION),
        { getHost },
      );
      await readBody(res);
    }
    const ids = calls
      .filter(([name]) => name === "editSessionMessage")
      .map(([, req]) => req.clientRequestId);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.notEqual(ids[0], "attacker-chosen");
    assert.notEqual(ids[1], "attacker-chosen");
    assert.equal(new Set(ids).size, 2);
  });

  test("asks for the turn diff to be rewound with the history", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    await route.handleMessageEdit(bodyReq({ ...ID, content: "x" }), res, ctx(SESSION), { getHost });
    await readBody(res);
    assert.equal(calls.find(([n]) => n === "editSessionMessage")[1].rewindTurnDiff, true);
  });

  test("a missing message id is refused before the host is touched", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageEdit(bodyReq({ content: "x" }), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "message_id_required");
    assert.equal(calls.length, 0);
  });

  test("a wrong-typed message id is a 400, not a missing one", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageEdit(
      bodyReq({ userMessageId: 7, content: "x" }),
      res,
      ctx(SESSION),
      { getHost },
    );
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "bad_field_type");
    assert.equal(calls.length, 0);
  });

  test("a wrong-typed content is a 400 before the host is touched", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageEdit(
      bodyReq({ ...ID, content: { text: "x" } }),
      res,
      ctx(SESSION),
      { getHost },
    );
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "bad_field_type");
    assert.equal(calls.length, 0);
  });

  test("whitespace-only content is refused", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageEdit(
      bodyReq({ ...ID, content: "   \n " }),
      res,
      ctx(SESSION),
      { getHost },
    );
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "message_text_required");
    assert.equal(calls.length, 0);
  });

  test("no live conversation is a 400 that names the real problem", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageEdit(
      bodyReq({ ...ID, content: "x" }),
      res,
      { cid: "c", cs: {} },
      { getHost },
    );
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "no_active_conversation");
    assert.equal(calls.length, 0);
  });

  test("the engine's rewound:false survives as rewound:false", async () => {
    const { getHost } = fakeHost({
      editSessionMessage: async () => ({ rewound: false }),
    });
    const res = fakeRes();
    const status = await route.handleMessageEdit(bodyReq({ ...ID, content: "x" }), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 200);
    assert.equal(body.rewound, false);
    assert.equal(body.deletedCount, 0);
  });

  test("an engine refusal keeps its status and its message", async () => {
    const refused = Object.assign(new Error("Rewind and Edit are unavailable while Plan Mode is active"), {
      status: 409,
      code: "CONVERSATION_MUTATION_BUSY",
    });
    const { getHost } = fakeHost({
      editSessionMessage: async () => {
        throw refused;
      },
    });
    const res = fakeRes();
    const status = await route.handleMessageEdit(bodyReq({ ...ID, content: "x" }), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.code, "CONVERSATION_MUTATION_BUSY");
    assert.match(body.error, /Plan Mode/);
  });

  test("a host without the method is a 501, not a guess", async () => {
    const getHost = async () => ({ cliService: { rewindSession: async () => ({}) } });
    const res = fakeRes();
    const status = await route.handleMessageEdit(bodyReq({ ...ID, content: "x" }), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 501);
    assert.equal(body.code, "engine_member_unavailable");
  });

  test("a missing host is a 503", async () => {
    const res = fakeRes();
    const status = await route.handleMessageEdit(bodyReq({ ...ID, content: "x" }), res, ctx(SESSION), {
      getHost: async () => null,
    });
    const body = await readBody(res);
    assert.equal(status, 503);
    assert.equal(body.code, "engine_host_unavailable");
  });
});

describe("POST /api/messages/rewind", () => {
  test("answers with the engine's file outcome verbatim", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 200);
    assert.equal(body.rewound, true);
    assert.equal(body.deletedCount, 1);
    assert.deepEqual(body.turnDiffRewind, {
      status: "reverted",
      revertedTurnIds: ["turn_1"],
    });
    const call = calls.find(([n]) => n === "rewindSession");
    assert.equal(call[1].id, SESSION);
    assert.equal(call[1].rewindTurnDiff, true);
    assert.equal(call[1].content, undefined);
  });

  test("no file outcome reported stays null, never a fabricated revert", async () => {
    const { getHost } = fakeHost({ rewindSession: async () => ({ rewound: true, deletedMessageIds: [] }) });
    const res = fakeRes();
    await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(body.turnDiffRewind, null);
  });

  test("a file outcome that carries an errorCode is passed through", async () => {
    const { getHost } = fakeHost({
      rewindSession: async () => ({
        rewound: true,
        deletedMessageIds: [],
        turnDiffRewind: { status: "partial", errorCode: "DIFF_CONFLICT" },
      }),
    });
    const res = fakeRes();
    await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.deepEqual(body.turnDiffRewind, { status: "partial", errorCode: "DIFF_CONFLICT" });
  });

  test("rewind ignores a session id in the body", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    await route.handleMessageRewind(
      bodyReq({ ...ID, sessionId: OTHER_SESSION }),
      res,
      ctx(SESSION),
      { getHost },
    );
    await readBody(res);
    assert.equal(calls.find(([n]) => n === "rewindSession")[1].id, SESSION);
  });

  test("a missing message id is refused before the host is touched", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq({}), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "message_id_required");
    assert.equal(calls.length, 0);
  });

  test("a blank message id is not a message id", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq({ userMessageId: "   " }), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "message_id_required");
    assert.equal(calls.length, 0);
  });

  test("a wrong-typed message id is a 400", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageRewind(
      bodyReq({ userMessageId: ["a"] }),
      res,
      ctx(SESSION),
      { getHost },
    );
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "bad_field_type");
    assert.equal(calls.length, 0);
  });

  test("no live conversation is a 400", async () => {
    const { getHost, calls } = okHost();
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq(ID), res, { cid: "c", cs: { mcodeSessionId: "" } }, { getHost });
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "no_active_conversation");
    assert.equal(calls.length, 0);
  });

  test("the engine's rewound:false survives", async () => {
    const { getHost } = fakeHost({ rewindSession: async () => ({ rewound: false }) });
    const res = fakeRes();
    await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(body.rewound, false);
    assert.equal(body.ok, true);
  });

  test("an engine refusal keeps its status", async () => {
    const refused = Object.assign(new Error("no such message in this session"), {
      status: 400,
      code: "MESSAGE_BOUNDARY_INVALID",
    });
    const { getHost } = fakeHost({
      rewindSession: async () => {
        throw refused;
      },
    });
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "MESSAGE_BOUNDARY_INVALID");
  });

  test("a host without rewindSession is a 501", async () => {
    const getHost = async () => ({ cliService: { editSessionMessage: async () => ({}) } });
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), { getHost });
    const body = await readBody(res);
    assert.equal(status, 501);
    assert.equal(body.code, "engine_member_unavailable");
  });

  test("a host that cannot be resolved is a 503", async () => {
    const res = fakeRes();
    const status = await route.handleMessageRewind(bodyReq(ID), res, ctx(SESSION), {
      getHost: async () => {
        throw new Error("catalogue host boot failed");
      },
    });
    const body = await readBody(res);
    assert.equal(status, 503);
    assert.equal(body.code, "engine_host_unavailable");
    assert.match(body.error, /boot failed/);
  });
});

describe("engine/message-edit.js — pure projections", () => {
  test("normalizeMessageId accepts a trimmed non-empty string only", () => {
    assert.equal(engine.normalizeMessageId(" m1 "), "m1");
    assert.equal(engine.normalizeMessageId(""), null);
    assert.equal(engine.normalizeMessageId("  "), null);
    assert.equal(engine.normalizeMessageId(7), null);
    assert.equal(engine.normalizeMessageId(undefined), null);
    assert.equal(engine.normalizeMessageId({}), null);
  });

  test("projectEditResult reports a missing answer as rewound:false, not a success", () => {
    assert.deepEqual(engine.projectEditResult(undefined), { rewound: false, deletedCount: 0 });
    assert.deepEqual(engine.projectEditResult({}), { rewound: false, deletedCount: 0 });
  });

  test("projectRewindResult ignores a diff report with no status", () => {
    assert.deepEqual(engine.projectRewindResult({ rewound: true, turnDiffRewind: { errorCode: "X" } }), {
      rewound: true,
      deletedCount: 0,
      turnDiffRewind: null,
    });
  });

  test("projectRewindResult drops non-string reverted turn ids", () => {
    const out = engine.projectRewindResult({
      rewound: true,
      turnDiffRewind: { status: "reverted", revertedTurnIds: ["t1", 3, null] },
    });
    assert.deepEqual(out.turnDiffRewind.revertedTurnIds, ["t1"]);
  });

  test("the action table names the two engine methods and nothing else", () => {
    assert.deepEqual(Object.keys(engine.MESSAGE_EDIT_ACTIONS).sort(), ["edit", "rewind"]);
    assert.equal(engine.MESSAGE_EDIT_ACTIONS.edit.method, "editSessionMessage");
    assert.equal(engine.MESSAGE_EDIT_ACTIONS.rewind.method, "rewindSession");
  });
});

describe("wiring", () => {
  const appSrc = readFileSync(join(import.meta.dirname, "..", "..", "server", "app.js"), "utf8");

  test("both routes are in OWNED_ROUTES and registered on the Hono app", () => {
    assert.match(appSrc, /"POST \/api\/messages\/edit"/);
    assert.match(appSrc, /"POST \/api\/messages\/rewind"/);
    assert.match(appSrc, /app\.post\("\/api\/messages\/edit"/);
    assert.match(appSrc, /app\.post\("\/api\/messages\/rewind"/);
    assert.match(appSrc, /messageEditRoute\.handleMessageEdit/);
    assert.match(appSrc, /messageEditRoute\.handleMessageRewind/);
  });
});