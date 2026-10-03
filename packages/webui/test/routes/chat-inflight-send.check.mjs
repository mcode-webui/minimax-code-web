// webui/test/routes/chat-inflight-send.check.mjs
//
// P16 — a message sent into a conversation that is already running a turn.
//
// The defect this suite exists for (UAT 2026-10-03 16点轮 异常 #1): a second
// send into a live conversation was ACKED and handed to the engine while the
// webui kept no record of it. The turn's echo landed in the live `cs.chat`,
// the run-mirror's finalize then wrote the record from a `loadSessions()`
// snapshot taken before it, and the user was left with a message the engine
// had executed and the history did not contain.
//
// The cause is identity drift, not a missing check. A first turn's draft
// record is promoted to the engine `mvs_` id mid-turn, and `cs.sessionId`
// follows it. The run was claimed under the retired draft key, so the next
// send presents a key no live run holds: `beginRun` cannot see the running
// turn, and its only remaining guard — `runsBySid` — is populated by a
// separate backfill that has not necessarily landed yet. A guard that
// cannot see the turn must not ack it.
//
// The invariants pinned here:
//   1. a send into a live conversation is REFUSED with 409, whatever identity
//      the conversation presents (draft key, promoted `mvs_` id);
//   2. the reverse half — a refused send never reaches the engine, is never
//      echoed into the transcript, and never reaches the persisted record;
//   3. the re-key does not leak the claim: once the turn ends, the same
//      conversation accepts a send again;
//   4. #139's parallel-conversation behaviour is untouched: a second
//      conversation of the SAME tab is a different key and still runs;
//   5. the refusal body names the decision in words a user can act on, and
//      keeps a machine-readable `reason` for the client's third banner state.
//
// This suite depends on t.mock.module → --experimental-test-module-mocks.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  setupMocks,
  absPath,
  registerSessionsStore,
  registerMcodeAcpMock,
  getSessionsStore,
} from "../helpers/_setup.js";

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
}

/** Parse a route response body; a JSON string is a failure, not a crash. */
function bodyOf(res) {
  try {
    return JSON.parse(res._body);
  } catch {
    return null;
  }
}

let handleSend, makeClientState, clients, bindDraftToMcodeSid;

before(async (t) => {
  await setupMocks(t, { mavis: { applyMavisUsageToCs: async () => {} } });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  bindDraftToMcodeSid = (await import(absPath("lib/sessions.js"))).bindDraftToMcodeSid;
  handleSend = (await import(absPath("routes/chat.js"))).handleSend;
});

beforeEach(() => {
  clients.clear();
  registerSessionsStore({ initial: [] });
});

/**
 * A transport that hangs on its first prompt and mimics the ACP runner's
 * mid-turn binding: the draft record is promoted to the engine id, and the
 * run claim is re-keyed with it (the production `moveRunSession` call lives
 * next to `bindDraftToMcodeSid` in `mcode-acp.js`, on both transports).
 */
function hangingRunner(sid, { backfillSid = true, rekey = true } = {}) {
  const seen = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const runner = async (content, opts) => {
    seen.push(content);
    if (seen.length === 1) {
      const sb = await import(absPath("lib/state-bus.js"));
      if (backfillSid) sb.updateRunSid(opts.cid, sid, opts.owningWebuiSessionId);
      bindDraftToMcodeSid(opts.cs, sid);
      if (rekey && opts.cs.sessionId !== opts.owningWebuiSessionId) {
        sb.moveRunSession(opts.cid, opts.owningWebuiSessionId, opts.cs.sessionId);
      }
      await gate;
    }
    return { status: "succeeded", answer: "mocked", sessionId: sid };
  };
  return { runner, seen, release, finish: () => release() };
}

describe("P16 — a send into a running conversation", () => {
  test("is refused with a 409, and the refusal names the decision", async () => {
    const { runner, seen, finish } = hangingRunner("mvs_busy");
    registerMcodeAcpMock({ runMcodeAcp: runner, runMcodeRuntime: runner });

    const cid = "cid-busy";
    const cs = makeClientState();
    cs.chat = [];
    clients.set(cid, cs);
    const first = handleSend(fakeReq({ content: "first" }), fakeRes(), { cs, cid });
    await new Promise((r) => setTimeout(r, 30));

    // The identity the view now presents: the promoted engine id.
    assert.equal(cs.sessionId, "mvs_busy", "the draft must have been promoted mid-turn");

    const res = fakeRes();
    await handleSend(fakeReq({ content: "second" }), res, { cs, cid });

    assert.equal(res._status, 409, "a send into a live turn must be refused, not acked");
    const body = bodyOf(res);
    assert.equal(body.ok, false);
    assert.equal(
      body.reason,
      "cid-busy",
      "the machine-readable reason drives the composer's third banner state",
    );
    assert.match(
      body.error,
      /NOT delivered/,
      "the user-facing message must state the message was not delivered",
    );
    assert.doesNotMatch(
      body.error,
      /another window/,
      "the internal detail's wording is wrong for the common case (same tab, second send)",
    );

    // ---- the reverse half: nothing about the refused send reached the engine
    assert.deepEqual(seen, ["first"], "a refused send must never reach the engine");
    assert.deepEqual(
      cs.chat,
      ["› first"],
      "a refused send must not be echoed into the live transcript",
    );
    for (const record of getSessionsStore()) {
      assert.ok(
        !record.chat.some((line) => line.includes("second")),
        "a refused send must not reach the persisted record",
      );
    }

    finish();
    await first;
  });

  test("is refused even when the engine-id backfill has not landed yet", async () => {
    // The drift alone is enough to hide the running turn from `beginRun`:
    // with `runsBySid` still empty the only guard is the conversation key,
    // which the promotion changed. This is the exact shape the UAT hit.
    const { runner, seen, finish } = hangingRunner("mvs_nobackfill", {
      backfillSid: false,
    });
    registerMcodeAcpMock({ runMcodeAcp: runner, runMcodeRuntime: runner });

    const cid = "cid-nobackfill";
    const cs = makeClientState();
    cs.chat = [];
    clients.set(cid, cs);
    const first = handleSend(fakeReq({ content: "first" }), fakeRes(), { cs, cid });
    await new Promise((r) => setTimeout(r, 30));

    const res = fakeRes();
    await handleSend(fakeReq({ content: "守株待兔，水墨国风" }), res, { cs, cid });

    assert.equal(res._status, 409);
    assert.deepEqual(seen, ["first"], "the engine must not be given a second concurrent turn");
    assert.ok(
      !cs.chat.some((line) => line.includes("守株待兔")),
      "the refused message must not appear in the transcript",
    );

    finish();
    await first;
    assert.ok(
      !getSessionsStore().some((r) => r.chat.some((l) => l.includes("守株待兔"))),
      "the refused message must not survive into the persisted record",
    );
  });

  test("the re-keyed claim is released when the turn ends (no leak)", async () => {
    const { runner, finish } = hangingRunner("mvs_release");
    registerMcodeAcpMock({ runMcodeAcp: runner, runMcodeRuntime: runner });

    const cid = "cid-release";
    const cs = makeClientState();
    cs.chat = [];
    clients.set(cid, cs);
    const first = handleSend(fakeReq({ content: "first" }), fakeRes(), { cs, cid });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cs.sessionId, "mvs_release");

    finish();
    await first;

    // The same conversation, now idle, must accept a send. A claim that
    // outlived its own turn would refuse every later send in it forever —
    // the failure mode an alias-blind release would have introduced here.
    const res = fakeRes();
    await handleSend(fakeReq({ content: "after" }), res, { cs, cid });
    assert.equal(res._status, 200, "a finished turn must leave the conversation sendable");
    assert.equal(
      fakeRes()._status,
      200,
      "sanity: a fresh response object defaults to 200, so 409 above is real",
    );
  });

  test("a second conversation of the same tab still runs in parallel (#139)", async () => {
    const { runner, seen, finish } = hangingRunner("mvs_a");
    registerMcodeAcpMock({ runMcodeAcp: runner, runMcodeRuntime: runner });

    const cid = "cid-parallel";
    const csA = makeClientState();
    csA.chat = [];
    const csB = makeClientState();
    csB.chat = [];
    // Two existing conversations — distinct claim keys, which is what #139
    // bought. Two unsaved drafts share the `null` key and are refused, which
    // is a different question and is covered by the guard's own suite.
    csB.sessionId = "web-B";
    registerSessionsStore({
      initial: [{ id: "web-B", title: "B", chat: [], workspace: null }],
    });
    clients.set(cid, csA);
    clients.set(cid, csB);

    const firstA = handleSend(fakeReq({ content: "A1" }), fakeRes(), { cs: csA, cid });
    await new Promise((r) => setTimeout(r, 30));
    const resB = fakeRes();
    const firstB = handleSend(fakeReq({ content: "B1" }), resB, { cs: csB, cid });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(resB._status, 200, "a DIFFERENT conversation of the same tab is not a busy send");
    assert.deepEqual(seen.sort(), ["A1", "B1"]);

    finish();
    await Promise.all([firstA, firstB]);
  });
});
