// webui/test/routes/goal.test.js
// The thread-goal family (PB-14 batch A, fact baseline
// `doc/pb14-goal-baseline.md` §1/§3) — the five windows over an engine
// surface that had existed, complete, with nothing in front of it.
//
// Hermetic by construction: every handler takes an optional fourth
// argument that reaches the engine facade's `getHost` seam, so these tests
// drive a fake `host.adapter` — no runtime boot, no network, no temporary
// directory, no spawned server.
//
// ELEVEN invariants, in the order they matter:
//
//   1. THE SESSION ID NEVER COMES FROM THE BODY. Every route reads it from
//      `ctx.cs.mcodeSessionId`, the same reason `/api/send`,
//      `/api/follow-up` and `/api/queue` do. The goal surface is the most
//      tempting place to break that rule, so the body is made to carry a
//      DECOY id and the fake engine records which one it was called with.
//   2. A DISABLED GOAL IS 503 `goal_disabled` AND NOTHING IS CALLED. The
//      engine throws a bare `Error("Thread Goal is disabled.")` with no
//      status, which a generic map can only turn into a 500 — a server
//      fault for a configuration fact.
//   3. A HOST THAT CANNOT SERVE GOALS IS 501, NOT AN EMPTY SUCCESS. The
//      default `acp` transport has no goal method, and #110 fake-success
//      discipline says the answer is a refusal.
//   4. NO GOAL IS A 404 `GOAL_NOT_FOUND`, both when the engine answers
//      `undefined` and when it throws its own `ThreadGoalContractError`
//      with status 404 — the engine's code reaches the wire as the code.
//   5. `{status:"complete", statusReason:"user_requested"}` WORKS AND
//      FORWARDS `{status:"complete"}` ONLY. This is the case the baseline
//      flags as the risk to verify: `statusReason` is not part of the
//      engine's patch contract, so forwarding it would hand the engine an
//      object it never declared.
//   6. A BARE `paused` IS FORWARDED AS `{status:"paused"}` — the engine
//      treats that shape as the atomic user-pause transition
//      (`compat/v1/runtime.ts#isBareUserPause`), so a facade that
//      "normalised" it into a different patch would change the meaning.
//   7. VALIDATION HAPPENS BEFORE THE ENGINE IS ASKED. objective
//      whitespace-only, a non-positive / fractional / non-numeric budget, a
//      status outside the six, and an empty patch are all 400s with the
//      engine untouched.
//   8. THE ENGINE'S GOAL IS PASSED THROUGH WHOLE. `statusReason`,
//      `lastVerification`, `executionWait` and the three usage counters
//      survive, because batch C's banner reads them and webui does not get
//      to decide which fields of a `GlobalThreadGoal` are real.
//   9. `/api/goal/enabled` NEEDS NO SESSION. It is the one route of the
//      five that answers for a tab which has not opened a conversation,
//      which is what lets the composer decide whether to offer the control.
//  10. `DELETE` REPORTS WHAT THE ENGINE DID. `clearGoal` answers false when
//      there was nothing to delete, and that is a 404 — not a 200 that
//      means "the click arrived".
//  11. A TAB WITH NO CONVERSATION IS A 400, NOT AN EMPTY ANSWER, on all
//      four session-scoped routes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const goalRoute = await import(absPath("routes/goal.js"));
const goalEngine = await import(absPath("engine/goal.js"));
const absFile = (rel) => join(import.meta.dirname, "..", "..", "server", rel);

const SESSION = "mvs_session_for_goal";
const DECOY = "mvs_session_the_body_tried_to_name";

/** A stand-in for the Node ServerResponse, mirroring queue.test.js. */
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
  const raw = payload === undefined ? "" : JSON.stringify(payload);
  return Readable.from([Buffer.from(raw)]);
}

function parsed(res) {
  return JSON.parse(res.body);
}

/** The engine's own `ThreadGoalContractError` shape, for the 404 case. */
function engineNotFound(sessionId) {
  const error = new Error(`Goal not found for session: ${sessionId}`);
  error.name = "ThreadGoalContractError";
  error.status = 404;
  error.code = "GOAL_NOT_FOUND";
  return error;
}

/**
 * A goal record with every field batch C's banner reads, so a projection
 * that dropped one would be caught here rather than in a screenshot.
 */
function engineGoal(overrides = {}) {
  return {
    goalId: "goal_01",
    sessionId: SESSION,
    objective: "ship the goal banner",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    tokensUsed: 4096,
    turnsUsed: 7,
    timeUsedSeconds: 91,
    tokenBudget: 50000,
    statusReason: "user_created",
    lastVerification: { verdict: "met", missing: [], notMetStreak: 0 },
    hasKickoffAttachments: false,
    executionWait: { reason: "awaiting_user", since: 3 },
    ...overrides,
  };
}

/**
 * A fake `host.adapter` that RECORDS every call, whatever it answers.
 *
 * The recording wrapper is applied on top of the answer rather than
 * replaced by it, because half these tests are about what reached the
 * engine as much as what came back: a 400 that still called `createGoal`,
 * or a `complete` patch that forwarded `statusReason`, are both invisible
 * to a status-only assertion. `null` as an answer removes the method, which
 * is how the 501 case is built.
 *
 * @param {Record<string, unknown>} [respond] Method name -> answer
 *   (value, thunk, or `null` to remove the method entirely).
 * @param {{enabled?: boolean}} [options] `enabled:false` makes
 *   `isGoalEnabled` report the feature as off.
 */
function fakeAdapter(respond = {}, options = {}) {
  const state = { calls: [] };
  const answers = {
    getGoal: () => engineGoal(),
    createGoal: () => engineGoal(),
    patchGoal: () => engineGoal(),
    clearGoal: () => true,
    ...respond,
  };
  const adapter = {};
  const wrap = (name, impl) => (...args) => {
    state.calls.push({ name, args });
    return typeof impl === "function" ? impl(...args) : impl;
  };
  adapter.isGoalEnabled =
    "isGoalEnabled" in answers
      ? wrap("isGoalEnabled", answers.isGoalEnabled)
      : wrap("isGoalEnabled", () => options.enabled !== false);
  for (const name of ["getGoal", "createGoal", "patchGoal", "clearGoal"]) {
    adapter[name] = wrap(name, answers[name]);
  }
  for (const [name, value] of Object.entries(respond)) {
    if (value === null) delete adapter[name];
  }
  return { adapter, getHost: async () => ({ adapter }), state };
}

/** The one call of a given method, or a test failure that names the miss. */
function callOf(state, name) {
  const found = state.calls.find((c) => c.name === name);
  assert.ok(found, `expected ${name} to be called; ledger was ${JSON.stringify(state.calls.map((c) => c.name))}`);
  return found;
}

/** The four session-scoped routes' shared context. */
function ctx(sessionId = SESSION) {
  return { cid: "c1", cs: { mcodeSessionId: sessionId } };
}

async function drive(handler, { payload, ctx: context = ctx(), getHost }) {
  const res = fakeRes();
  const status = await handler(bodyReq(payload), res, context, { getHost });
  await res.done;
  return { status, body: parsed(res), res };
}

// ---------------------------------------------------------------------------

describe("GET /api/goal/enabled — the frontend's switch check", () => {
  test("answers the engine's own flag, true or false", async () => {
    for (const flag of [true, false]) {
      const { getHost } = fakeAdapter({ isGoalEnabled: () => flag });
      const { status, body } = await drive(goalRoute.handleGoalEnabled, { getHost });
      assert.equal(status, 200);
      assert.deepEqual(body, { ok: true, enabled: flag });
    }
  });

  test("invariant 9: it needs no engine session — a tab with no conversation still gets an answer", async () => {
    const { getHost } = fakeAdapter();
    const { status, body } = await drive(goalRoute.handleGoalEnabled, {
      ctx: { cid: "c1", cs: {} },
      getHost,
    });
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
  });

  test("invariant 3: no runtime is 503, and a host without the method is 501", async () => {
    const gone = await drive(goalRoute.handleGoalEnabled, { getHost: async () => null });
    assert.equal(gone.status, 503);
    assert.equal(gone.body.code, "engine_host_unavailable");

    const { getHost } = fakeAdapter({ isGoalEnabled: null });
    const missing = await drive(goalRoute.handleGoalEnabled, { getHost });
    assert.equal(missing.status, 501);
    assert.equal(missing.body.code, "engine_member_unavailable");
  });

  test("a flag method that throws is reported, not read as \"off\"", async () => {
    const { getHost } = fakeAdapter({
      isGoalEnabled: () => {
        throw new Error("the flag reader blew up");
      },
    });
    const { status, body } = await drive(goalRoute.handleGoalEnabled, { getHost });
    assert.equal(status, 500);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------

describe("GET /api/goal — this conversation's goal", () => {
  test("invariant 8: the engine's goal is passed through whole", async () => {
    const goal = engineGoal();
    const { getHost, state } = fakeAdapter({ getGoal: async () => goal });
    const { status, body } = await drive(goalRoute.handleGoalRead, { getHost });
    assert.equal(status, 200);
    assert.deepEqual(body.goal, goal);
    for (const field of [
      "statusReason",
      "lastVerification",
      "executionWait",
      "tokensUsed",
      "turnsUsed",
      "timeUsedSeconds",
      "tokenBudget",
    ]) {
      assert.ok(field in body.goal, `${field} must survive the projection`);
    }
    assert.deepEqual(state.calls.map((c) => c.name), ["isGoalEnabled", "getGoal"]);
  });

  test("invariant 1: the session id is the tab's, never the body's", async () => {
    const { getHost, state } = fakeAdapter({ getGoal: async () => engineGoal() });
    await drive(goalRoute.handleGoalRead, {
      payload: { sessionId: DECOY },
      getHost,
    });
    assert.equal(callOf(state, "getGoal").args[0], SESSION);
    assert.notEqual(callOf(state, "getGoal").args[0], DECOY);
  });

  test("invariant 4: `undefined` from the engine is a 404 GOAL_NOT_FOUND, not an empty goal", async () => {
    const { getHost } = fakeAdapter({ getGoal: async () => undefined });
    const { status, body } = await drive(goalRoute.handleGoalRead, { getHost });
    assert.equal(status, 404);
    assert.equal(body.code, "GOAL_NOT_FOUND");
    assert.equal("goal" in body, false);
  });

  test("invariant 4: the engine's own 404 reaches the wire with ITS code and status", async () => {
    const { getHost } = fakeAdapter({
      getGoal: async () => {
        throw engineNotFound(SESSION);
      },
    });
    const { status, body } = await drive(goalRoute.handleGoalRead, { getHost });
    assert.equal(status, 404);
    assert.equal(body.code, "GOAL_NOT_FOUND");
    assert.match(body.error, /Goal not found for session/);
  });

  test("invariant 2: a disabled goal is 503 goal_disabled and getGoal is NEVER called", async () => {
    const { getHost, state } = fakeAdapter(
      { getGoal: async () => engineGoal() },
      { enabled: false },
    );
    const { status, body } = await drive(goalRoute.handleGoalRead, { getHost });
    assert.equal(status, 503);
    assert.equal(body.code, "goal_disabled");
    assert.deepEqual(state.calls.map((c) => c.name), ["isGoalEnabled"]);
  });

  test("an engine answer that is not an object is a 502, not a thrown error", async () => {
    const { getHost } = fakeAdapter({ getGoal: async () => "not a goal" });
    const { status, body } = await drive(goalRoute.handleGoalRead, { getHost });
    assert.equal(status, 502);
    assert.equal(body.code, "engine_contract_violation");
  });
});

// ---------------------------------------------------------------------------

describe("POST /api/goal — create", () => {
  test("forwards the tab's session id with the objective and the budget", async () => {
    const { getHost, state } = fakeAdapter({
      createGoal: async () => engineGoal({ status: "active", statusReason: "user_created" }),
    });
    const { status, body } = await drive(goalRoute.handleGoalCreate, {
      payload: { objective: "ship the goal banner", tokenBudget: 50000, sessionId: DECOY },
      getHost,
    });
    assert.equal(status, 200);
    assert.equal(body.goal.status, "active");
    const call = callOf(state, "createGoal");
    assert.deepEqual(call.args[0], {
      sessionId: SESSION,
      objective: "ship the goal banner",
      tokenBudget: 50000,
    });
  });

  test("an absent budget is OMITTED from the call, not sent as null", async () => {
    const { getHost, state } = fakeAdapter({ createGoal: async () => engineGoal() });
    await drive(goalRoute.handleGoalCreate, {
      payload: { objective: "no budget" },
      getHost,
    });
    const call = callOf(state, "createGoal");
    assert.equal("tokenBudget" in call.args[0], false);
  });

  test("an explicit null budget reaches the engine as null — \"no budget\" is a real choice", async () => {
    const { getHost, state } = fakeAdapter({ createGoal: async () => engineGoal({ tokenBudget: null }) });
    const { status } = await drive(goalRoute.handleGoalCreate, {
      payload: { objective: "unbounded", tokenBudget: null },
      getHost,
    });
    assert.equal(status, 200);
    const call = callOf(state, "createGoal");
    assert.equal(call.args[0].tokenBudget, null);
  });

  test("invariant 7: a bad objective is a 400 and createGoal is never called", async () => {
    for (const objective of ["", "   ", 42, null, undefined, { text: "x" }]) {
      const { getHost, state } = fakeAdapter();
      const { status, body } = await drive(goalRoute.handleGoalCreate, {
        payload: { objective },
        getHost,
      });
      assert.equal(status, 400, `objective ${JSON.stringify(objective)} must be refused`);
      assert.equal(body.code, "invalid_body");
      assert.equal(state.calls.filter((c) => c.name === "createGoal").length, 0);
    }
  });

  test("invariant 7: a bad budget is a 400 and createGoal is never called", async () => {
    // NaN and Infinity are NOT in this list, and the omission is a fact
    // about JSON rather than a gap in coverage: `JSON.stringify` turns
    // both into `null` before they reach a route, so the wire cannot carry
    // them. The validator is pinned on both directly, below.
    for (const tokenBudget of [0, -1, 1.5, "50000", true, [1]]) {
      const { getHost, state } = fakeAdapter();
      const { status, body } = await drive(goalRoute.handleGoalCreate, {
        payload: { objective: "real objective", tokenBudget },
        getHost,
      });
      assert.equal(status, 400, `tokenBudget ${String(tokenBudget)} must be refused`);
      assert.equal(body.code, "invalid_body");
      assert.match(body.error, /tokenBudget/);
      assert.equal(state.calls.filter((c) => c.name === "createGoal").length, 0);
    }
  });

  test("invariant 2: disabled means 503 and nothing is created", async () => {
    const { getHost, state } = fakeAdapter(
      { createGoal: async () => engineGoal() },
      { enabled: false },
    );
    const { status, body } = await drive(goalRoute.handleGoalCreate, {
      payload: { objective: "real objective" },
      getHost,
    });
    assert.equal(status, 503);
    assert.equal(body.code, "goal_disabled");
    assert.deepEqual(state.calls.map((c) => c.name), ["isGoalEnabled"]);
  });

  test("invariant 3: a host with no createGoal is 501", async () => {
    const { getHost } = fakeAdapter({ createGoal: null });
    const { status, body } = await drive(goalRoute.handleGoalCreate, {
      payload: { objective: "real objective" },
      getHost,
    });
    assert.equal(status, 501);
    assert.equal(body.code, "engine_member_unavailable");
  });
});

// ---------------------------------------------------------------------------

describe("PATCH /api/goal — change it", () => {
  // The case the baseline names as the risk to verify.
  test("invariant 5: {status:\"complete\", statusReason:\"user_requested\"} works and forwards status ONLY", async () => {
    const { getHost, state } = fakeAdapter({
      patchGoal: async () => engineGoal({ status: "complete", statusReason: "user_requested" }),
    });
    const { status, body } = await drive(goalRoute.handleGoalPatch, {
      payload: { status: "complete", statusReason: "user_requested" },
      getHost,
    });
    assert.equal(status, 200);
    assert.equal(body.goal.status, "complete");
    assert.equal(body.goal.statusReason, "user_requested");
    const call = callOf(state, "patchGoal");
    assert.equal(call.args[0], SESSION);
    // `statusReason` is NOT part of the engine's patch contract
    // (`TuiGoalAccess.patch` takes status / objective / tokenBudget only),
    // so it must not travel.
    assert.deepEqual(call.args[1], { status: "complete" });
  });

  test("invariant 6: a bare paused is forwarded as {status:\"paused\"} — the engine's atomic user-pause shape", async () => {
    const { getHost, state } = fakeAdapter({
      patchGoal: async () => engineGoal({ status: "paused", statusReason: "user_paused" }),
    });
    const { status } = await drive(goalRoute.handleGoalPatch, {
      payload: { status: "paused" },
      getHost,
    });
    assert.equal(status, 200);
    const call = callOf(state, "patchGoal");
    assert.deepEqual(call.args[1], { status: "paused" });
  });

  test("an objective edit forwards only the objective", async () => {
    const { getHost, state } = fakeAdapter({
      patchGoal: async () => engineGoal({ objective: "a better objective" }),
    });
    const { status, body } = await drive(goalRoute.handleGoalPatch, {
      payload: { objective: "a better objective" },
      getHost,
    });
    assert.equal(status, 200);
    assert.equal(body.goal.objective, "a better objective");
    const call = callOf(state, "patchGoal");
    assert.deepEqual(call.args[1], { objective: "a better objective" });
  });

  test("a budget edit accepts null and a positive integer, and refuses the rest", async () => {
    for (const tokenBudget of [null, 1, 50000]) {
      const { getHost, state } = fakeAdapter({ patchGoal: async () => engineGoal({ tokenBudget }) });
      const { status } = await drive(goalRoute.handleGoalPatch, {
        payload: { tokenBudget },
        getHost,
      });
      assert.equal(status, 200, `tokenBudget ${String(tokenBudget)} must be accepted`);
      const call = callOf(state, "patchGoal");
      assert.equal(call.args[1].tokenBudget, tokenBudget);
    }
    for (const tokenBudget of [0, -5, 2.5, "50000"]) {
      const { getHost, state } = fakeAdapter();
      const { status } = await drive(goalRoute.handleGoalPatch, {
        payload: { tokenBudget },
        getHost,
      });
      assert.equal(status, 400, `tokenBudget ${String(tokenBudget)} must be refused`);
      assert.equal(state.calls.filter((c) => c.name === "patchGoal").length, 0);
    }
  });

  test("all six statuses are accepted", async () => {
    for (const status of [
      "active",
      "paused",
      "blocked",
      "complete",
      "budget_limited",
      "usage_limited",
    ]) {
      const { getHost } = fakeAdapter({ patchGoal: async () => engineGoal({ status }) });
      const { status: http } = await drive(goalRoute.handleGoalPatch, {
        payload: { status },
        getHost,
      });
      assert.equal(http, 200, `status ${status} must be accepted`);
    }
  });

  test("invariant 7: a status outside the six is a 400 and patchGoal is never called", async () => {
    for (const status of ["done", "Active", "cancelled", "", 1, null]) {
      const { getHost, state } = fakeAdapter();
      const { status: http, body } = await drive(goalRoute.handleGoalPatch, {
        payload: { status },
        getHost,
      });
      assert.equal(http, 400, `status ${JSON.stringify(status)} must be refused`);
      assert.equal(body.code, "invalid_body");
      assert.equal(state.calls.filter((c) => c.name === "patchGoal").length, 0);
    }
  });

  test("invariant 7: an empty patch is a 400 — there is nothing to change", async () => {
    const { getHost, state } = fakeAdapter();
    const { status, body } = await drive(goalRoute.handleGoalPatch, {
      payload: { statusReason: "user_requested" },
      getHost,
    });
    assert.equal(status, 400);
    assert.equal(body.code, "invalid_body");
    assert.match(body.error, /at least one/);
    assert.equal(state.calls.filter((c) => c.name === "patchGoal").length, 0);
  });

  test("invariant 4: the engine's 404 on patch reaches the wire unchanged", async () => {
    const { getHost } = fakeAdapter({
      patchGoal: async () => {
        throw engineNotFound(SESSION);
      },
    });
    const { status, body } = await drive(goalRoute.handleGoalPatch, {
      payload: { status: "complete" },
      getHost,
    });
    assert.equal(status, 404);
    assert.equal(body.code, "GOAL_NOT_FOUND");
  });

  test("invariant 2: disabled means 503 and nothing is patched", async () => {
    const { getHost, state } = fakeAdapter(
      { patchGoal: async () => engineGoal() },
      { enabled: false },
    );
    const { status, body } = await drive(goalRoute.handleGoalPatch, {
      payload: { status: "paused" },
      getHost,
    });
    assert.equal(status, 503);
    assert.equal(body.code, "goal_disabled");
    assert.deepEqual(state.calls.map((c) => c.name), ["isGoalEnabled"]);
  });
});

// ---------------------------------------------------------------------------

describe("DELETE /api/goal — drop it", () => {
  test("invariant 10: a real delete answers the engine's own true", async () => {
    const { getHost, state } = fakeAdapter({ clearGoal: async () => true });
    const { status, body } = await drive(goalRoute.handleGoalClear, { getHost });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, success: true });
    assert.equal(callOf(state, "clearGoal").args[0], SESSION);
  });

  test("invariant 10: a false from the engine is a 404 — \"there was nothing to delete\" is not a success", async () => {
    const { getHost } = fakeAdapter({ clearGoal: async () => false });
    const { status, body } = await drive(goalRoute.handleGoalClear, { getHost });
    assert.equal(status, 404);
    assert.equal(body.code, "GOAL_NOT_FOUND");
  });

  test("invariant 1: the session id is the tab's, never the body's", async () => {
    const { getHost, state } = fakeAdapter({ clearGoal: async () => true });
    await drive(goalRoute.handleGoalClear, { payload: { sessionId: DECOY }, getHost });
    assert.equal(callOf(state, "clearGoal").args[0], SESSION);
  });

  test("invariant 2: disabled means 503 and nothing is cleared", async () => {
    const { getHost, state } = fakeAdapter({ clearGoal: async () => true }, { enabled: false });
    const { status, body } = await drive(goalRoute.handleGoalClear, { getHost });
    assert.equal(status, 503);
    assert.equal(body.code, "goal_disabled");
    assert.deepEqual(state.calls.map((c) => c.name), ["isGoalEnabled"]);
  });

  test("the engine's own 404 on clear reaches the wire unchanged", async () => {
    const { getHost } = fakeAdapter({
      clearGoal: async () => {
        throw engineNotFound(SESSION);
      },
    });
    const { status, body } = await drive(goalRoute.handleGoalClear, { getHost });
    assert.equal(status, 404);
    assert.equal(body.code, "GOAL_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------

describe("invariant 11 — a tab with no conversation is a 400 on all four session-scoped routes", () => {
  const cases = [
    ["GET", goalRoute.handleGoalRead],
    ["POST", goalRoute.handleGoalCreate],
    ["PATCH", goalRoute.handleGoalPatch],
    ["DELETE", goalRoute.handleGoalClear],
  ];

  for (const [method, handler] of cases) {
    test(`${method} /api/goal without an engine session is 400 no_active_conversation`, async () => {
      const { getHost, state } = fakeAdapter();
      const { status, body } = await drive(handler, {
        payload: method === "POST" ? { objective: "x" } : method === "PATCH" ? { status: "complete" } : undefined,
        ctx: { cid: "c1", cs: {} },
        getHost,
      });
      assert.equal(status, 400);
      assert.equal(body.code, "no_active_conversation");
      // Nothing reached the engine — not even the enabled flag.
      assert.deepEqual(state.calls, []);
    });
  }
});

// ---------------------------------------------------------------------------

describe("route registration — the five paths exist in app.js with these handlers", () => {
  const appSource = readFileSync(absFile("app.js"), "utf8");

  test("all five are in the OWNED_ROUTES ledger", () => {
    for (const entry of [
      '"GET /api/goal/enabled"',
      '"GET /api/goal"',
      '"POST /api/goal"',
      '"PATCH /api/goal"',
      '"DELETE /api/goal"',
    ]) {
      assert.ok(appSource.includes(entry), `${entry} must be in OWNED_ROUTES`);
    }
  });

  test("all five are registered on the Hono app with the right handler", () => {
    const pairs = [
      ['app.get("/api/goal/enabled"', "handleGoalEnabled"],
      ['app.get("/api/goal"', "handleGoalRead"],
      ['app.post("/api/goal"', "handleGoalCreate"],
      ['app.patch("/api/goal"', "handleGoalPatch"],
      ['app.delete("/api/goal"', "handleGoalClear"],
    ];
    for (const [call, handler] of pairs) {
      const at = appSource.indexOf(call);
      assert.notEqual(at, -1, `${call} must be registered`);
      const window = appSource.slice(at, at + 200);
      assert.ok(window.includes(handler), `${call} must reach ${handler}`);
    }
  });

  test("/api/goal/enabled is registered BEFORE /api/goal", () => {
    const enabled = appSource.indexOf('app.get("/api/goal/enabled"');
    const plain = appSource.indexOf('app.get("/api/goal"');
    assert.ok(enabled > -1 && plain > enabled, "the literal must be registered first");
  });
});

// ---------------------------------------------------------------------------

describe("engine facade — the action table is the contract", () => {
  test("five actions, all on the adapter, each naming a real engine method", () => {
    assert.deepEqual(Object.keys(goalEngine.GOAL_ACTIONS).sort(), [
      "clear",
      "create",
      "enabled",
      "patch",
      "read",
    ]);
    const methods = Object.values(goalEngine.GOAL_ACTIONS).map((a) => a.method).sort();
    assert.deepEqual(methods, [
      "clearGoal",
      "createGoal",
      "getGoal",
      "isGoalEnabled",
      "patchGoal",
    ]);
    for (const action of Object.values(goalEngine.GOAL_ACTIONS)) {
      assert.equal(action.member, "adapter");
    }
  });

  test("the six statuses are the engine's, spelled the engine's way", () => {
    assert.deepEqual([...goalEngine.GOAL_STATUSES].sort(), [
      "active",
      "blocked",
      "budget_limited",
      "complete",
      "paused",
      "usage_limited",
    ]);
  });

  test("the validators are total: they answer a value, never a throw", () => {
    assert.equal(goalEngine.validateGoalObjective("x"), null);
    assert.equal(goalEngine.validateGoalObjective("").ok, false);
    assert.equal(goalEngine.validateGoalTokenBudget(undefined), null);
    assert.equal(goalEngine.validateGoalTokenBudget(null), null);
    for (const bad of [0, -1, 1.5, "50000", NaN, Infinity, true]) {
      const verdict = goalEngine.validateGoalTokenBudget(bad);
      assert.equal(verdict.ok, false, `tokenBudget ${String(bad)} must be refused`);
      assert.equal(verdict.status, 400);
    }
  });
});
