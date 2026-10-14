// webui/test/routes/queue.test.js
// The queue family (PB-13, plan `doc/placeholder-batch-plan.md` §5 row 5,
// G-1) — the three windows over the engine's queue surface that SB-4
// left with nothing in front of them.
//
// Hermetic by construction: every handler takes an optional fourth
// argument that reaches the engine facade's `getHost` seam, so these
// tests drive a fake `host.cliService` — no runtime boot, no network, no
// temporary directory, no spawned server.
//
// SIX invariants, in the order they matter:
//
//   1. THE LIST IS THE ENGINE'S LIST. The response is
//      `cliService.listQueueMessages`'s own items, in its own order,
//      with its own ids. A server that re-sorted, deduplicated or
//      re-numbered them would be making a claim about the engine's
//      queue that the engine did not make.
//   2. AN UNREACHABLE QUEUE IS NOT AN EMPTY ONE. When this process does
//      not own the running turn — the normal state under the default
//      `acp` transport, where the turn lives in an `mcode acp`
//      subprocess — the LIST answers 200 with `reachable:false` and an
//      empty item array. It is not a 409 and it is not
//      `{reachable:true, items:[]}`: the first would make a polled
//      endpoint raise a banner every four seconds, the second would
//      claim the engine's queue is empty when nobody asked it.
//   3. NOTHING IS CALLED WHEN THE GATE FAILS. A queue read that reaches
//      `listQueueMessages` without a locally-owned turn would be
//      reading another process's state through a window that has no
//      business reading it — the engine's `requireMutableSession` would
//      throw, and a test that only asserted the status would miss that
//      the call was made at all.
//   4. REORDER SENDS THE WHOLE LIST, AND THE ENGINE'S ANSWER WINS. The
//      engine's `reorderQueue` compares the submitted ids against the
//      ids it considers user-manageable; a delta earns a 400. The
//      response is the engine's new order, not the requested one.
//   5. CANCEL IS THE ENGINE'S CANCEL. `deleteQueueItem` is what the
//      engine calls a cancel (`queue.cancel`), and the answer is the
//      engine's own cancelled item — not a 200 that means "the click
//      arrived".
//   6. THE SESSION ID NEVER COMES FROM THE BODY. Every route reads it
//      from `ctx.cs.mcodeSessionId`, the same reason `/api/send` and
//      `/api/follow-up` do: a client that named its own session could
//      aim a queue control at a conversation the tab is not showing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const queueRoute = await import(absPath("routes/queue.js"));
const queueEngine = await import(absPath("engine/queue.js"));
const absFile = (rel) => join(import.meta.dirname, "..", "..", "server", rel);

const SESSION = "mvs_session_for_queue";

/** A stand-in for the Node ServerResponse, mirroring follow-up.test.js. */
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

function bodyReq(payload, url) {
  const stream = Readable.from([
    Buffer.from(payload === undefined ? "" : JSON.stringify(payload), "utf8"),
  ]);
  stream.url = url;
  return stream;
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body);
}

const ctx = (sessionId) => ({ cid: "c", cs: { mcodeSessionId: sessionId } });

/**
 * A fake `host.cliService` whose queue calls are counted, so a test can
 * assert that a method was NOT reached — the shape a status-only
 * assertion would miss.
 */
function fakeHost(overrides = {}) {
  const calls = [];
  const host = {
    calls,
    cliService: {
      getActiveTurn: async (sessionId) => {
        calls.push(["getActiveTurn", sessionId]);
        return { turnId: "turn_1", locallyOwned: true };
      },
      listQueueMessages: async (req) => {
        calls.push(["listQueueMessages", req]);
        return {
          paused: false,
          pendingCount: 2,
          items: [
            { itemId: "qi_1", sessionId: req.id, status: "queued", content: "first", createdAt: 11 },
            { itemId: "qi_2", sessionId: req.id, status: "queued", content: "second", createdAt: 12 },
          ],
        };
      },
      reorderQueue: async (req) => {
        calls.push(["reorderQueue", req]);
        return {
          items: req.itemIds.map((itemId, index) => ({
            itemId,
            sessionId: req.id,
            status: "queued",
            content: `msg-${index}`,
          })),
        };
      },
      deleteQueueItem: async (req) => {
        calls.push(["deleteQueueItem", req]);
        return {
          item: {
            itemId: req.itemId,
            sessionId: req.id,
            status: "cancelled",
            content: "gone",
            finishedAt: 99,
          },
        };
      },
    },
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete host.cliService[name];
    else host.cliService[name] = value;
  }
  return host;
}

const called = (host, name) => host.calls.filter((call) => call[0] === name);

describe("GET /api/queue", () => {
  test("answers the engine's own list, in the engine's own order", async () => {
    const host = fakeHost();
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    assert.equal(res.status, 200);
    const body = await readBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.reachable, true);
    // The order is the engine's, untouched — invariant 1.
    assert.deepEqual(
      body.items.map((item) => item.itemId),
      ["qi_1", "qi_2"],
    );
    assert.equal(body.items[0].content, "first");
    assert.equal(body.pendingCount, 2);
    assert.equal(body.paused, false);
    assert.equal(called(host, "listQueueMessages").length, 1);
    // The gate is asked first, with the server's own session id.
    assert.deepEqual(called(host, "getActiveTurn")[0][1], SESSION);
  });

  test("an unreachable queue answers 200 with reachable:false, not an empty list", async () => {
    // Invariant 2. `locallyOwned:false` is what the acp transport
    // produces for a turn running in a subprocess.
    const host = fakeHost({ getActiveTurn: async () => ({ turnId: "t", locallyOwned: false }) });
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    assert.equal(res.status, 200);
    const body = await readBody(res);
    assert.equal(body.reachable, false);
    assert.equal(body.reason, "turn_not_here");
    assert.deepEqual(body.items, []);
    // Invariant 3: the engine was never asked for the list.
    assert.equal(called(host, "listQueueMessages").length, 0);
  });

  test("no running turn is the same unreachable fact, not a 500", async () => {
    const host = fakeHost({ getActiveTurn: async () => undefined });
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    assert.equal(res.status, 200);
    assert.equal((await readBody(res)).reachable, false);
    assert.equal(called(host, "listQueueMessages").length, 0);
  });

  test("a tab with no engine conversation is a 400 that names the reason", async () => {
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(""), {
      getHost: async () => fakeHost(),
    });
    assert.equal(res.status, 400);
    const body = await readBody(res);
    assert.equal(body.code, "no_active_conversation");
    // The message must name the REAL problem. Answering an empty list
    // or a "the queue is empty" sentence here would be a claim about
    // the engine's queue that nobody asked the engine for.
    assert.match(body.error, /no live conversation/);
    assert.doesNotMatch(body.error, /queue is empty/);
  });

  test("an engine refusal keeps its own status and code", async () => {
    const host = fakeHost({
      listQueueMessages: async () => {
        const error = new Error("nope");
        error.status = 404;
        error.code = "SESSION_NOT_FOUND";
        throw error;
      },
    });
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    assert.equal(res.status, 404);
    assert.equal((await readBody(res)).code, "SESSION_NOT_FOUND");
  });

  test("a host without the list method is a 501, not an empty queue", async () => {
    const host = fakeHost({ listQueueMessages: null });
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    assert.equal(res.status, 501);
    assert.equal((await readBody(res)).code, "engine_member_unavailable");
  });

  test("an item with no id is dropped rather than rendered unmanageable", async () => {
    const host = fakeHost({
      listQueueMessages: async () => ({
        paused: true,
        pendingCount: 3,
        items: [
          { itemId: "qi_1", status: "queued", content: "kept" },
          { status: "queued", content: "no id" },
          { itemId: "", status: "queued", content: "empty id" },
        ],
      }),
    });
    const res = fakeRes();
    await queueRoute.handleQueueList(bodyReq(undefined, "/api/queue"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    const body = await readBody(res);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].itemId, "qi_1");
    // The engine's paused flag is passed through even though this
    // family offers no resume control — the fact is the engine's.
    assert.equal(body.paused, true);
  });
});

describe("POST /api/queue/reorder", () => {
  test("forwards the whole ordered list and answers the engine's order", async () => {
    // Invariant 4.
    const host = fakeHost();
    const res = fakeRes();
    await queueRoute.handleQueueReorder(
      bodyReq({ itemIds: ["qi_2", "qi_1"] }, "/api/queue/reorder"),
      res,
      ctx(SESSION),
      { getHost: async () => host },
    );
    assert.equal(res.status, 200);
    const body = await readBody(res);
    assert.deepEqual(
      body.items.map((item) => item.itemId),
      ["qi_2", "qi_1"],
    );
    assert.deepEqual(called(host, "reorderQueue")[0][1], { id: SESSION, itemIds: ["qi_2", "qi_1"] });
  });

  test("a list that could not be a queue is refused before the engine is asked", async () => {
    for (const itemIds of [["qi_1", "qi_1"], ["qi_1", 7], ["qi_1", ""]]) {
      const host = fakeHost();
      const res = fakeRes();
      await queueRoute.handleQueueReorder(
        bodyReq({ itemIds }, "/api/queue/reorder"),
        res,
        ctx(SESSION),
        { getHost: async () => host },
      );
      assert.equal(res.status, 400);
      assert.equal((await readBody(res)).code, "invalid_queue_order");
      assert.equal(called(host, "reorderQueue").length, 0);
    }
  });

  test("a non-array itemIds is a BAD_FIELD_TYPE, not an invalid order", async () => {
    const res = fakeRes();
    await queueRoute.handleQueueReorder(
      bodyReq({ itemIds: "qi_1" }, "/api/queue/reorder"),
      res,
      ctx(SESSION),
      { getHost: async () => fakeHost() },
    );
    assert.equal(res.status, 400);
    assert.equal((await readBody(res)).code, "BAD_FIELD_TYPE");
  });

  test("an unreachable queue is a 409 on a WRITE", async () => {
    // The deliberate asymmetry with the list, stated in
    // `engine/queue.js`: a polled read says `reachable:false`, a button
    // press the user is waiting on has to fail loudly.
    const host = fakeHost({ getActiveTurn: async () => ({ turnId: "t", locallyOwned: false }) });
    const res = fakeRes();
    await queueRoute.handleQueueReorder(
      bodyReq({ itemIds: ["qi_1"] }, "/api/queue/reorder"),
      res,
      ctx(SESSION),
      { getHost: async () => host },
    );
    assert.equal(res.status, 409);
    assert.equal((await readBody(res)).code, "turn_not_here");
    assert.equal(called(host, "reorderQueue").length, 0);
  });
});

describe("POST /api/queue/cancel", async () => {
  test("cancels through the engine and answers the engine's own item", async () => {
    // Invariant 5.
    const host = fakeHost();
    const res = fakeRes();
    await queueRoute.handleQueueCancel(
      bodyReq({ itemId: "qi_1" }, "/api/queue/cancel"),
      res,
      ctx(SESSION),
      { getHost: async () => host },
    );
    assert.equal(res.status, 200);
    const body = await readBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.item.itemId, "qi_1");
    assert.equal(body.item.status, "cancelled");
    assert.deepEqual(called(host, "deleteQueueItem")[0][1], { id: SESSION, itemId: "qi_1" });
  });

  test("a missing itemId names the field rather than cancelling nothing", async () => {
    const host = fakeHost();
    const res = fakeRes();
    await queueRoute.handleQueueCancel(bodyReq({}, "/api/queue/cancel"), res, ctx(SESSION), {
      getHost: async () => host,
    });
    assert.equal(res.status, 400);
    assert.equal((await readBody(res)).code, "queue_item_required");
    assert.equal(called(host, "deleteQueueItem").length, 0);
  });

  test("an empty-string itemId is refused, not forwarded to the engine", async () => {
    const host = fakeHost();
    const res = fakeRes();
    await queueRoute.handleQueueCancel(
      bodyReq({ itemId: "" }, "/api/queue/cancel"),
      res,
      ctx(SESSION),
      { getHost: async () => host },
    );
    assert.equal(res.status, 400);
    assert.equal(called(host, "deleteQueueItem").length, 0);
  });

  test("an unreachable queue is a 409: the cancel did NOT happen", async () => {
    const host = fakeHost({ getActiveTurn: async () => undefined });
    const res = fakeRes();
    await queueRoute.handleQueueCancel(
      bodyReq({ itemId: "qi_1" }, "/api/queue/cancel"),
      res,
      ctx(SESSION),
      { getHost: async () => host },
    );
    assert.equal(res.status, 409);
    assert.equal((await readBody(res)).code, "turn_not_here");
    assert.equal(called(host, "deleteQueueItem").length, 0);
  });
});

describe("the session id is never taken from the body", () => {
  // Invariant 6. A client that named its own session could aim a queue
  // control at a conversation this tab is not showing.
  test("a sessionId in the body is ignored on all three routes", async () => {
    const host = fakeHost();
    await queueRoute.handleQueueList(
      bodyReq({ sessionId: "mvs_someone_elses" }, "/api/queue"),
      fakeRes(),
      ctx(SESSION),
      { getHost: async () => host },
    );
    await queueRoute.handleQueueReorder(
      bodyReq({ itemIds: ["qi_1"], sessionId: "mvs_someone_elses" }, "/api/queue/reorder"),
      fakeRes(),
      ctx(SESSION),
      { getHost: async () => host },
    );
    await queueRoute.handleQueueCancel(
      bodyReq({ itemId: "qi_1", sessionId: "mvs_someone_elses" }, "/api/queue/cancel"),
      fakeRes(),
      ctx(SESSION),
      { getHost: async () => host },
    );
    for (const name of ["getActiveTurn", "listQueueMessages", "reorderQueue", "deleteQueueItem"]) {
      for (const call of called(host, name)) {
        const payload = call[1];
        const engineSession = typeof payload === "string" ? payload : payload.id;
        assert.equal(engineSession, SESSION);
      }
    }
  });
});

describe("the engine facade's own units", () => {
  test("classifyQueueReachability is total over the gate's three answers", () => {
    assert.equal(queueEngine.classifyQueueReachability(undefined).code, "turn_not_here");
    assert.equal(queueEngine.classifyQueueReachability(null).code, "turn_not_here");
    assert.equal(queueEngine.classifyQueueReachability("nope").code, "turn_not_here");
    assert.equal(
      queueEngine.classifyQueueReachability({ locallyOwned: false }).code,
      "turn_not_here",
    );
    // A turn record with NO `locallyOwned` field is not an owning turn.
    // The check is `!== true` rather than `=== false` precisely so that
    // a shape this build has not seen before is refused rather than
    // admitted — admitting it would let a second turn start.
    assert.equal(
      queueEngine.classifyQueueReachability({ turnId: "t" }).code,
      "turn_not_here",
    );
    assert.equal(
      queueEngine.classifyQueueReachability({ turnId: "t", locallyOwned: "true" }).code,
      "turn_not_here",
    );
    assert.equal(queueEngine.classifyQueueReachability({ locallyOwned: true }), null);
  });

  test("an unreachable queue is never described as an empty one", () => {
    // The gate's message reaches the user verbatim on a WRITE. Wording
    // it as "the queue is empty" would tell someone who just pressed
    // cancel that there was nothing to cancel, when the truth is that
    // the queue is somewhere this process cannot see.
    for (const answer of [undefined, { locallyOwned: false }]) {
      const refusal = queueEngine.classifyQueueReachability(answer);
      assert.doesNotMatch(refusal.error, /empty/i);
      assert.match(refusal.error, /another engine process|no running turn/);
    }
  });

  test("projectQueueList keeps the engine's order and counts", () => {
    const projected = queueEngine.projectQueueList({
      paused: true,
      pendingCount: 5,
      items: [
        { itemId: "a", content: "x", attachments: [{}, {}] },
        { itemId: "b" },
      ],
    });
    assert.deepEqual(projected.items.map((i) => i.itemId), ["a", "b"]);
    // The attachment COUNT is what the panel shows; the attachment
    // records themselves never leave the server.
    assert.equal(projected.items[0].attachmentCount, 2);
    assert.equal(projected.pendingCount, 5);
    assert.equal(projected.paused, true);
  });

  test("projectQueueList survives an answer that is not an object", () => {
    assert.deepEqual(queueEngine.projectQueueList(undefined), {
      items: [],
      paused: false,
      pendingCount: 0,
    });
  });

  test("normalizeQueueItemIds refuses anything that could not be a queue", () => {
    assert.deepEqual(queueEngine.normalizeQueueItemIds(["a", "b"]), ["a", "b"]);
    // A duplicate id is not an ordering, it is a set with a hole in it.
    assert.equal(queueEngine.normalizeQueueItemIds(["a", "a"]), null);
    assert.equal(queueEngine.normalizeQueueItemIds(["a", ""]), null);
    assert.equal(queueEngine.normalizeQueueItemIds(["a", 7]), null);
    assert.equal(queueEngine.normalizeQueueItemIds("a"), null);
    assert.equal(queueEngine.normalizeQueueItemIds(null), null);
  });

  test("normalizeQueueItemId refuses an absent or empty id", () => {
    assert.equal(queueEngine.normalizeQueueItemId("qi_1"), "qi_1");
    assert.equal(queueEngine.normalizeQueueItemId(""), null);
    assert.equal(queueEngine.normalizeQueueItemId(undefined), null);
    assert.equal(queueEngine.normalizeQueueItemId(7), null);
  });

  test("an explicit pendingCount of zero is the ENGINE's number, not a fallback", () => {
    // The engine can report fewer pending items than the list carries
    // (a system-managed item it filters out). Falling back to the item
    // count when the engine said 0 would be the server inventing a
    // number the engine did not give.
    const projected = queueEngine.projectQueueList({ pendingCount: 0, items: [{ itemId: "a" }] });
    assert.equal(projected.pendingCount, 0);
    const missing = queueEngine.projectQueueList({ items: [{ itemId: "a" }] });
    assert.equal(missing.pendingCount, 1);
  });

  test("the facade contains no sorting of its own", async () => {
    // The engine is the only thing that knows the real order; the
    // facade must contain no sorting of its own. Pinned so a future
    // "helpfully stable sort" cannot land.
    const source = readFileSync(absFile("engine/queue.js"), "utf8");
    assert.equal(/\.sort\s*\(/.test(source), false);
  });
});
