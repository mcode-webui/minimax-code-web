// webui/server/routes/goal.js
//
// The thread-goal HTTP surface (PB-14 batch A, fact baseline
// `doc/pb14-goal-baseline.md` §1/§3):
//
//   GET    /api/goal/enabled — the frontend's switch check
//   GET    /api/goal         — this conversation's goal, or 404
//   POST   /api/goal         — create it
//   PATCH  /api/goal         — change status / objective / budget
//   DELETE /api/goal         — drop it
//
// This file is the HTTP shape and nothing else. Which engine method each
// route reaches, the enabled gate, the validation and the error mapping
// live in `../engine/goal.js` — the same split `routes/queue.js` keeps.
//
// WHY THE SESSION ID IS NOT TAKEN FROM THE BODY — the same reason as
// `/api/queue` and `/api/follow-up`. The composer knows nothing about
// engine session ids; it knows the webui session the user is looking at,
// and the server holds the mapping in `ctx.cs.mcodeSessionId`. A
// body-supplied id would be one more unvalidated engine identifier on the
// wire, and one a user could aim at a conversation this tab is not
// showing. The goal surface is the most tempting place to break that rule
// — a goal belongs to a conversation and the id looks like the obvious
// key — which is why the reason is written here rather than left to the
// next reader.
//
// WHY `enabled` IS NOT ASKED FOR ON THE OTHER FOUR. The four session-scoped
// routes answer 503 `goal_disabled` when the engine has the feature off,
// with NOTHING called, because `engine/goal.js` asks `isGoalEnabled` once
// per request. A client that wants to know in advance asks
// `/api/goal/enabled`; a client that does not still gets the truth on
// every write rather than a 500.
//
// Every handler takes an optional FOURTH argument forwarded to the engine
// facade's `getHost` seam — nothing in production, a fake host in
// `test/routes/goal.test.js`. `app.js#invokeHandler` passes three, so the
// seam costs production nothing and keeps the suite hermetic.

import { readJson } from "../lib/read-json.js";
import { ensureGoalEventBridge } from "../engine/goal-events.js";
import {
  clearEngineGoal,
  createEngineGoal,
  patchEngineGoal,
  readEngineGoal,
  readEngineGoalEnabled,
} from "../engine/goal.js";

/**
 * Re-arm the engine→SSE goal subscription after a write, WITHOUT awaiting it.
 *
 * WHY A WRITE PATH HAS TO DO THIS (PB-14 batch C). The bridge is armed from
 * two places: the SSE connect (`routes/state.js`) and, from this batch, the
 * three write handlers. The second arming point is not redundancy, it is the
 * one that makes the FIRST correct:
 *
 *   - `ensureGoalEventBridge` peeks the catalogue host and starts a pump
 *     only if a runtime is already up. On the default `acp` transport no
 *     host exists, so the connect-time arm is a no-op and the tab keeps
 *     `threadGoal: null` — fine, because on that transport the goal lives in
 *     an `mcode acp` subprocess webui does not host and has no event stream
 *     to read.
 *   - The local-runtime transport is the opposite case: the host is up but
 *     the bridge may have stopped (the pump ends on any non-abort engine
 *     error, by `pumpGoalEvents`' own contract). A goal written through
 *     `POST /api/goal` is therefore the one moment webui KNOWS a goal
 *     changed and cannot prove a subscription is listening.
 *
 * So each successful write re-arms it. That is cheap and idempotent — the
 * function returns `true` in a microtask when a pump is already running and
 * touches nothing — and it is fire-and-forget on purpose: the write's answer
 * is the engine's snapshot and must not wait on a subscription that may
 * never start on this transport. A rejection is swallowed for the same
 * reason `pumpGoalEvents` swallows a stream error: `ensureGoalEventBridge`
 * returns a boolean and never rejects, so there is nothing to catch, and the
 * `.catch` here only defends the module boundary.
 *
 * WHY IT IS NOT ON THE TWO READS. A read changes nothing in the engine, so
 * there is no new event to miss; arming there would fire on every session
 * switch for a subscription the connect path already owns.
 *
 * @param {() => (Promise<unknown>|unknown)} [ensure] Test seam: production
 *   leaves it unset and the real `ensureGoalEventBridge` is used. It takes
 *   no arguments in either case, which is itself pinned — an arming call
 *   that started passing a session id would be a second code path the tests
 *   could not see.
 * @returns {Promise<void>} Resolves when the arming attempt settles.
 */
function rearmGoalEventBridge(ensure) {
  const run = ensure || ensureGoalEventBridge;
  void Promise.resolve(run()).catch(() => {});
}

/**
 * Write one answer, whether it succeeded or not.
 *
 * Copied rather than imported from `routes/queue.js` on purpose: that
 * helper is not exported, and exporting a four-line `writeResult` across a
 * family boundary to save four lines would couple two route files that
 * have no other reason to change together.
 *
 * @param {object} res
 * @param {{ok: boolean, status?: number, payload?: object, code?: string, error?: string}} result
 * @returns {number} The status written.
 */
function writeResult(res, result) {
  if (result.ok) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result.payload));
    return 200;
  }
  const status = Number.isInteger(result.status) ? result.status : 500;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      code: result.code || "engine_call_failed",
      error: result.error || "the engine call failed",
    }),
  );
  return status;
}

/**
 * The engine session id for this tab, or a 400 that says so.
 *
 * Same reason and same sentence as `routes/queue.js`: a 400 naming the
 * real problem beats an empty answer, because an empty answer would be a
 * claim ("there is no goal") the server has not established — the tab
 * simply has not opened a conversation yet.
 *
 * @param {object} res
 * @param {object} ctx The per-cid conversation state.
 * @returns {string|null} The session id, or `null` when a 400 was written.
 */
function requireEngineSessionId(res, ctx) {
  const sessionId = (ctx && ctx.cs && ctx.cs.mcodeSessionId) || "";
  if (sessionId) return sessionId;
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      code: "no_active_conversation",
      error:
        "goal: this tab has no live conversation with an engine session, so it has no goal to read or change",
    }),
  );
  return null;
}

/**
 * GET /api/goal/enabled — 200 `{ok, enabled}`.
 *
 * No session id is needed: the flag belongs to the ENGINE, not to a
 * conversation, so this is the one route of the five that answers for a
 * tab which has not opened one yet. That is deliberate — it is what lets
 * the composer decide whether to offer a goal control at all.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleGoalEnabled(req, res, ctx, deps = {}) {
  return writeResult(res, await readEngineGoalEnabled({ ...deps }));
}

/**
 * GET /api/goal — 200 `{ok, goal}`, or 404 `GOAL_NOT_FOUND`.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleGoalRead(req, res, ctx, deps = {}) {
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(res, await readEngineGoal({ ...deps, sessionId }));
}

/**
 * POST /api/goal — body `{objective, tokenBudget?}`.
 *
 * The body is read for the two goal fields and nothing else. An unknown
 * key is ignored rather than refused: the desktop client sends
 * `sessionId` on the wire, and refusing it would make this endpoint the
 * one place the two implementations disagree about the same operation.
 * The session id it sends is not used — see the file header.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleGoalCreate(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  const result = await createEngineGoal({
    ...deps,
    sessionId,
    objective: parsed.objective,
    ...(parsed.tokenBudget !== undefined
      ? { tokenBudget: parsed.tokenBudget }
      : {}),
  });
  if (result.ok) rearmGoalEventBridge(deps.ensureBridge);
  return writeResult(res, result);
}

/**
 * PATCH /api/goal — body `{status?, objective?, tokenBudget?,
 * statusReason?}`.
 *
 * `statusReason` is tolerated and dropped; `engine/goal.js#patchEngineGoal`
 * says why (the engine derives it). It is listed here so the next reader
 * sees that its absence from the forwarded patch is deliberate.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleGoalPatch(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  const result = await patchEngineGoal({
    ...deps,
    sessionId,
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.objective !== undefined ? { objective: parsed.objective } : {}),
    ...(parsed.tokenBudget !== undefined
      ? { tokenBudget: parsed.tokenBudget }
      : {}),
  });
  if (result.ok) rearmGoalEventBridge(deps.ensureBridge);
  return writeResult(res, result);
}

/**
 * DELETE /api/goal — 200 `{ok, success:true}` or 404 `GOAL_NOT_FOUND`.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleGoalClear(req, res, ctx, deps = {}) {
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  const result = await clearEngineGoal({ ...deps, sessionId });
  if (result.ok) rearmGoalEventBridge(deps.ensureBridge);
  return writeResult(res, result);
}
