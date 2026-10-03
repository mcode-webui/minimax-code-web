// webui/test/routes/follow-up.test.js
// The `/api/follow-up` family (settings batch SB-4) — the composer's
// 跟进消息行为 switch reaching `cliService.enqueueMessage` / `steer`.
//
// Hermetic by construction: every handler takes an optional fourth
// argument that reaches the engine facade's `getHost` seam, so these
// tests drive a fake `host.cliService` — no runtime boot, no network, no
// temporary directory, no spawned server.
//
// FIVE invariants, in the order they matter:
//
//   1. THE OWNERSHIP GATE. A follow-up is only legal while THIS PROCESS
//      owns the running turn. Under the default `acp` transport the turn
//      lives in an `mcode acp` subprocess, and `submit({allowQueue:true})`
//      on an idle session commits the queue item and wakes the dispatcher
//      — a SECOND live turn for a session that already has one. So the
//      gate reads `getActiveTurn` and refuses both "no turn" and "a turn
//      this process does not own", with two DIFFERENT codes, because they
//      are two different facts and the composer words them differently.
//   2. NOTHING IS SENT WHEN THE GATE FAILS. The engine write must not be
//      reached at all — a refusal that still queued the message would be
//      the exact fake-success shape this gate exists to prevent.
//   3. THE RESPONSE IS ENGINE TRUTH. A queue answers with the engine's own
//      item id and position, a steer with the engine's own turn id; the
//      request is never echoed back as if it were a receipt.
//   4. THE THREE ENGINE FAILURES STAY THREE FAILURES. No host → 503, a
//      host without the method → 501, an engine refusal → its own status
//      and code.
//   5. THE OFF POSITION CANNOT REACH THE WIRE AS A DOWNGRADE. `off` is
//      the composer rendering no send control; a request that carries it
//      is a client that ignored the setting, and it is a 400 rather than a
//      silent queue.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const absFile = (rel) => join(import.meta.dirname, "..", "..", rel);
const followUpRoute = await import(absPath("routes/follow-up.js"));
const followUpEngine = await import(absPath("engine/follow-up.js"));
const attachmentsLib = await import(absPath("lib/attachments.js"));
const { ownsRequest } = await import(absPath("app.js"));

const SESSION = "mvs_session_for_follow_up";

/** A stand-in for the Node ServerResponse, mirroring model-source.test.js. */
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
  const stream = Readable.from([
    Buffer.from(payload === undefined ? "" : JSON.stringify(payload), "utf8"),
  ]);
  stream.url = "/api/follow-up";
  return stream;
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body || "{}");
}

/** The context `/api/follow-up` reads: the per-cid conversation's
 *  ENGINE session id, exactly as `/api/send` gets it. */
function ctx(sessionId = SESSION) {
  return { cs: { mcodeSessionId: sessionId } };
}

/**
 * A fake catalogue host. `active` is what `getActiveTurn` reports, and it
 * is the knob the gate is driven with: `{locallyOwned:true}` is a turn
 * this process runs, `{locallyOwned:false}` is a turn in an `mcode acp`
 * subprocess, `undefined` is no turn at all.
 */
function fakeHost(overrides = {}) {
  const calls = [];
  const state = {
    active:
      "active" in overrides ? overrides.active : { turnId: "turn_1", locallyOwned: true },
    ...(overrides.store || {}),
  };
  const cliService = {
    async getActiveTurn(sessionId) {
      calls.push(["getActiveTurn", sessionId]);
      return state.active;
    },
    async enqueueMessage(input) {
      calls.push(["enqueueMessage", input]);
      return { itemId: `qi_${calls.length}`, status: "queued", position: 2 };
    },
    async steer(input) {
      calls.push(["steer", input]);
      return { turnId: "turn_1", mode: "steered" };
    },
  };
  for (const [name, value] of Object.entries(overrides.methods || {})) {
    if (value === null) delete cliService[name];
    else cliService[name] = value;
  }
  const host = { cliService };
  return { host, cliService, calls, state, getHost: async () => host };
}

/** Post a follow-up through the route with a fake host. */
async function post(fake, payload, context = ctx()) {
  const res = fakeRes();
  await followUpRoute.handleFollowUp(bodyReq(payload), res, context, {
    getHost: fake.getHost,
    attachmentsLib,
  });
  return { res, body: await readBody(res) };
}

const QUEUE_BODY = { behavior: "queue", content: "also check the migration" };
const STEER_BODY = { behavior: "steer", content: "stop, use the other table" };

// --- 1. the two actions reach the engine -----------------------------------

describe("POST /api/follow-up reaches the engine", () => {
  test("queue calls enqueueMessage with the engine session id and answers the engine's commit", async () => {
    const fake = fakeHost();
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.behavior, "queue");
    // The engine's own ids, not the request: an item id and a position the
    // engine never recorded would send the user looking for a queue entry
    // that does not exist.
    assert.equal(body.itemId, "qi_2");
    assert.equal(body.position, 2);
    const call = fake.calls.find(([name]) => name === "enqueueMessage");
    assert.ok(call, "the engine's queue method must be called");
    assert.equal(call[1].id, SESSION, "the engine session id, not the webui one");
    assert.equal(call[1].content, QUEUE_BODY.content);
  });

  test("steer calls steer with the engine's own steering vocabulary", async () => {
    const fake = fakeHost();
    const { res, body } = await post(fake, STEER_BODY);
    assert.equal(res.status, 200);
    assert.equal(body.behavior, "steer");
    assert.equal(body.turnId, "turn_1");
    assert.equal(body.mode, "steered");
    const call = fake.calls.find(([name]) => name === "steer");
    assert.ok(call, "the engine's steering method must be called");
    // `composer-steer` is the engine's own user-steering producer
    // (turn-system/agent-host/runner/contracts.ts#USER_STEERING_PRODUCERS):
    // a message under any other id is dropped at turn teardown instead of
    // being requeued.
    assert.equal(call[1].producerId, "composer-steer");
    assert.equal(call[1].sessionId, SESSION);
    assert.equal(call[1].source, "api");
    assert.equal(call[1].message.content, STEER_BODY.content);
  });

  test("the per-send identity is forwarded as the engine's dedupe key", async () => {
    const fake = fakeHost();
    await post(fake, { ...QUEUE_BODY, requestId: "cid.1.2" });
    const queued = fake.calls.find(([name]) => name === "enqueueMessage")[1];
    assert.equal(queued.clientRequestId, "cid.1.2");
    const fake2 = fakeHost();
    await post(fake2, { ...STEER_BODY, requestId: "cid.1.2" });
    const steered = fake2.calls.find(([name]) => name === "steer")[1];
    assert.equal(steered.idempotencyKey, "cid.1.2");
  });

  test("an identity the server cannot accept is dropped, not rejected", async () => {
    // The identity guards against a double submit; refusing the MESSAGE
    // over it would be a worse lie than sending it once.
    const fake = fakeHost();
    const { res } = await post(fake, { ...QUEUE_BODY, requestId: "not a valid id!" });
    assert.equal(res.status, 200);
    const queued = fake.calls.find(([name]) => name === "enqueueMessage")[1];
    assert.equal(queued.clientRequestId, undefined);
  });
});

// --- 2. the ownership gate --------------------------------------------------

describe("the ownership gate", () => {
  test("a turn this process does not own is refused, and NOTHING is queued", async () => {
    // The acp transport's situation: a turn is running, in another
    // process. Queueing into this host would wake its dispatcher and start
    // a second turn for a session that already has one.
    const fake = fakeHost({ active: { turnId: "turn_1", locallyOwned: false } });
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 409);
    assert.equal(body.code, "turn_not_owned");
    assert.equal(
      fake.calls.some(([name]) => name === "enqueueMessage"),
      false,
      "a refused follow-up must not reach the engine write",
    );
  });

  test("no running turn is a DIFFERENT refusal, and also queues nothing", async () => {
    const fake = fakeHost({ active: undefined });
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 409);
    assert.equal(body.code, "no_active_turn");
    assert.equal(fake.calls.some(([name]) => name === "enqueueMessage"), false);
  });

  test("the gate is asked BEFORE the action, for both actions", async () => {
    for (const payload of [QUEUE_BODY, STEER_BODY]) {
      const fake = fakeHost();
      await post(fake, payload);
      const names = fake.calls.map(([name]) => name);
      assert.equal(names[0], "getActiveTurn", "the gate must run first");
      assert.ok(
        names.indexOf("getActiveTurn") < names.indexOf(payload.behavior === "queue" ? "enqueueMessage" : "steer"),
        "the action must not precede the gate",
      );
    }
  });

  test("a host without the gate member is 501, not an unverified guess", async () => {
    const fake = fakeHost({ methods: { getActiveTurn: null } });
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 501);
    assert.equal(body.code, "engine_member_unavailable");
    assert.equal(fake.calls.some(([name]) => name === "enqueueMessage"), false);
  });

  test("a gate read that throws is a 500 with no engine text", async () => {
    const fake = fakeHost();
    fake.cliService.getActiveTurn = async () => {
      throw new Error("turn table at /home/somebody/.mavis/turns.sqlite is corrupt");
    };
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 500);
    assert.equal(body.code, "engine_error");
    assert.ok(
      !res.body.includes(".mavis"),
      "an exception string from an unknown thrower must not reach the wire",
    );
  });
});

// --- 3. the three engine failures stay three -------------------------------

describe("the engine failures", () => {
  test("no host is 503", async () => {
    const res = fakeRes();
    await followUpRoute.handleFollowUp(bodyReq(QUEUE_BODY), res, ctx(), {
      getHost: async () => null,
      attachmentsLib,
    });
    const body = await readBody(res);
    assert.equal(res.status, 503);
    assert.equal(body.code, "engine_host_unavailable");
  });

  test("a host getter that throws is 503 with a body, not an unhandled rejection", async () => {
    const res = fakeRes();
    await followUpRoute.handleFollowUp(bodyReq(QUEUE_BODY), res, ctx(), {
      getHost: async () => {
        throw new Error("the runtime failed to boot");
      },
      attachmentsLib,
    });
    const body = await readBody(res);
    assert.equal(res.status, 503);
    assert.equal(body.code, "engine_host_unavailable");
  });

  test("a host without enqueueMessage is 501", async () => {
    const fake = fakeHost({ methods: { enqueueMessage: null } });
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 501);
    assert.equal(body.code, "engine_member_unavailable");
  });

  test("an engine refusal keeps its own status and code", async () => {
    const fake = fakeHost();
    fake.cliService.enqueueMessage = async () => {
      const err = new Error("Session not found: mvs_x");
      err.status = 404;
      err.code = "local_session_not_found";
      throw err;
    };
    const { res, body } = await post(fake, QUEUE_BODY);
    assert.equal(res.status, 404);
    assert.equal(body.code, "local_session_not_found");
  });

  test("a rejected steering message is a 409 with the engine's reason", async () => {
    // `ConversationTurnRejectedError` carries no status but does carry a
    // stable code and a reason; a refusal must not be flattened into a
    // 500 that reads like a broken route.
    const fake = fakeHost();
    fake.cliService.steer = async () => {
      const err = new Error("Conversation Turn was rejected");
      err.code = "CONVERSATION_TURN_REJECTED";
      err.reason = "delivery-closed";
      throw err;
    };
    const { res, body } = await post(fake, STEER_BODY);
    assert.equal(res.status, 409);
    assert.equal(body.code, "CONVERSATION_TURN_REJECTED");
    assert.ok(body.error.includes("delivery-closed"));
  });
});

// --- 4. input validation ---------------------------------------------------

describe("what the route refuses before it reaches the engine", () => {
  test("an unknown behaviour is a 400 naming the two that exist", async () => {
    for (const behavior of ["off", "", "QUEUE", "cancel"]) {
      const fake = fakeHost();
      const { res, body } = await post(fake, { behavior, content: "x" });
      assert.equal(res.status, 400, behavior);
      assert.equal(body.code, "invalid_follow_up_behavior");
      assert.ok(body.error.includes("queue") && body.error.includes("steer"));
      assert.equal(fake.calls.length, 0, "a refused request must not boot or call the engine");
    }
  });

  test("a field of the wrong type is a 400 naming the field", async () => {
    const cases = [
      [{ behavior: 7, content: "x" }, "behavior"],
      [{ behavior: "queue", content: [] }, "content"],
      [{ behavior: "queue", content: "x", attachments: "@/tmp/a" }, "attachments"],
      [{ behavior: "queue", content: "x", requestId: 12 }, "requestId"],
    ];
    for (const [payload, field] of cases) {
      const fake = fakeHost();
      const { res, body } = await post(fake, payload);
      assert.equal(res.status, 400, field);
      assert.equal(body.code, "BAD_FIELD_TYPE");
      assert.ok(body.error.includes(field));
    }
  });

  test("an empty message is a 400, and reaches no engine", async () => {
    const fake = fakeHost();
    const { res, body } = await post(fake, { behavior: "queue", content: "   " });
    assert.equal(res.status, 400);
    assert.equal(body.code, "follow_up_empty");
    assert.equal(fake.calls.length, 0);
  });

  test("a tab with no live conversation is a 400, not a queue with no owner", async () => {
    // The session id comes from the server's own conversation state, so a
    // client cannot aim a message at a conversation it is not showing.
    const fake = fakeHost();
    const { res, body } = await post(fake, QUEUE_BODY, ctx(""));
    assert.equal(res.status, 400);
    assert.equal(body.code, "no_active_conversation");
    assert.equal(fake.calls.length, 0);
  });

  test("an untrusted attachment path is dropped and the message still goes", async () => {
    // Same rule as `/api/send`: a chip that cannot be resolved must not
    // become a silent success ("the model saw the file"). With no
    // attachments left, the text still carries the request.
    const fake = fakeHost();
    const { res } = await post(fake, { ...QUEUE_BODY, attachments: ["@/etc/passwd"] });
    assert.equal(res.status, 200);
    const queued = fake.calls.find(([name]) => name === "enqueueMessage")[1];
    assert.equal(queued.attachments, undefined);
  });
});

// --- 5. the route and the engine facade agree on the surface ---------------

describe("the declared surface", () => {
  test("the app's OWNED_ROUTES contains the family exactly once", () => {
    assert.equal(ownsRequest("POST", "/api/follow-up"), true);
  });

  test("the engine table names the two methods that exist upstream", () => {
    // A drift here would 501 every follow-up on a host that has the
    // method under another name; pin it against the cli-service source
    // rather than against a comment.
    const cliServiceSource = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "local-runtime-v2", "src", "local", "cli-service.ts"),
      "utf8",
    );
    for (const action of Object.values(followUpEngine.FOLLOW_UP_ACTIONS)) {
      assert.ok(
        new RegExp(`\\n\\s{2}${action.method}\\(`).test(cliServiceSource),
        `cli-service.ts must declare ${action.method}`,
      );
    }
    assert.ok(
      new RegExp(`\\n\\s{2}${followUpEngine.FOLLOW_UP_GATE_METHOD}\\(`).test(cliServiceSource),
      "cli-service.ts must declare the gate method",
    );
  });

  test("the route reaches the engine only through getEngineCatalogueHost", () => {
    // The SB-1 discipline: no second host getter, no direct runtime
    // import, so the "one host per process" rule cannot be bypassed here.
    const engineSource = readFileSync(absFile("server/engine/follow-up.js"), "utf8");
    assert.ok(
      engineSource.includes("getEngineCatalogueHost"),
      "the engine facade must boot through getEngineCatalogueHost",
    );
    assert.ok(
      !/getCatalogueHost\(/.test(engineSource),
      "the facade must not call the un-namespaced getter directly",
    );
    assert.ok(
      !engineSource.includes("peekEngineCatalogueHost"),
      "a write may boot what it needs; this is a write",
    );
  });

  test("the producer id and the refusal codes are the engine's own vocabulary", () => {
    const runnerSource = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "local-runtime-v2",
        "src",
        "service",
        "turn-system",
        "agent-host",
        "runner",
        "contracts.ts",
      ),
      "utf8",
    );
    assert.ok(
      runnerSource.includes(`'${followUpEngine.FOLLOW_UP_STEER_PRODUCER_ID}'`),
      "the steering producer must be one the engine treats as user steering",
    );
    const clientSource = readFileSync(absFile("webapp/lib/follow-up.ts"), "utf8");
    for (const code of Object.keys(followUpEngine.FOLLOW_UP_CODES)) {
      assert.ok(clientSource.includes(code), `the client must know the ${code} code`);
    }
  });

  test("the client and the server spell the behaviour whitelist the same way", async () => {
    const clientSource = readFileSync(absFile("webapp/lib/follow-up.ts"), "utf8");
    for (const action of followUpEngine.FOLLOW_UP_ACTION_KEYS) {
      assert.ok(
        clientSource.includes(`"${action}"`),
        `the client must be able to produce the ${action} action`,
      );
    }
  });
});
