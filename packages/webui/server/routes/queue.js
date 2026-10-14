// webui/server/routes/queue.js
//
// The queue half of the follow-up family (PB-13, plan
// `doc/placeholder-batch-plan.md` §5 row 5, G-1):
//
//   GET  /api/queue         — the panel's list
//   POST /api/queue/reorder — the panel's reorder
//   POST /api/queue/cancel  — the panel's cancel
//
// This file is the HTTP shape and nothing else. Which engine method
// each route reaches, the reachability gate, the projections and the
// error mapping live in `../engine/queue.js`, the same split
// `routes/follow-up.js` keeps.
//
// WHY THE SESSION ID IS NOT TAKEN FROM THE BODY — the same reason as
// `/api/follow-up`. The panel knows nothing about engine session ids;
// it knows the webui session the user is looking at, and the server
// holds the mapping in `ctx.cs.mcodeSessionId`. A body-supplied id
// would be one more unvalidated engine identifier on the wire, and one
// the user could aim at a conversation this tab is not showing.
//
// WHY THREE ROUTES AND NOT ONE WITH A DISCRIMINATOR. Reorder and cancel
// are presses of a button that either changed the queue or did not; the
// client needs to know which. A single endpoint would carry an action
// string that the server would then have to validate against a table
// anyway, which is what a path segment already is.

import { readJson } from "../lib/read-json.js";
import {
  cancelEngineQueueItem,
  readEngineQueue,
  reorderEngineQueue,
} from "../engine/queue.js";

/**
 * Write one answer, whether it succeeded or not.
 *
 * Copied rather than imported from `routes/follow-up.js` on purpose:
 * that helper is not exported, and exporting a four-line `writeResult`
 * across a family boundary to save four lines would couple two route
 * files that have no other reason to change together.
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
 * Every route in this family needs it and none can proceed without it,
 * so the refusal is written once here rather than three times. The
 * message names the real problem — there is no conversation to show a
 * queue for — instead of returning an empty list, which would be a
 * claim ("the queue is empty") that the server has not established.
 *
 * @param {object} res
 * @param {object} ctx The per-cid conversation state.
 * @returns {string|null} The session id, or `null` when a 400 was
 *   already written.
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
        "the queue: this tab has no live conversation with an engine session, so there is no queue to show",
    }),
  );
  return null;
}

/**
 * Reject an optional field that is present with the wrong type.
 *
 * Same reason as `routes/follow-up.js#rejectWrongType`: `readJson`
 * normalises an absent body to `{}`, so the only thing that CAN
 * arrive wrong is a type, and silently treating `{"itemId": 7}` as
 * "no item id" would turn a client's bug into a refusal that names
 * the wrong problem.
 *
 * @param {object} res
 * @param {unknown} value
 * @param {string} field
 * @param {string} expected
 * @returns {number|null} The status written, or `null` when acceptable.
 */
function rejectWrongType(res, value, field, expected) {
  if (value === undefined || value === null) return null;
  const actual = Array.isArray(value) ? "array" : typeof value;
  if (actual === expected) return null;
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      code: "BAD_FIELD_TYPE",
      error: `${field} must be ${expected === "array" ? "an array" : `a ${expected}`}`,
    }),
  );
  return 400;
}

/**
 * GET /api/queue — the queued messages for the running turn.
 *
 * 200 `{ok, reachable, items, paused, pendingCount}`. `reachable` is
 * false when the engine does not hold this session's turn in this
 * process (the default `acp` transport runs turns in a subprocess), and
 * the client then draws the honest note instead of an empty queue.
 *
 * Every handler takes an optional FOURTH argument forwarded to the
 * engine facade's `getHost` seam — nothing in production, a fake host
 * in `test/routes/queue.test.js`. `app.js#invokeHandler` passes three,
 * so the seam costs production nothing and keeps the suite hermetic.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleQueueList(req, res, ctx, deps = {}) {
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(
    res,
    await readEngineQueue({ ...deps, sessionId }),
  );
}

/**
 * POST /api/queue/reorder — body `{itemIds: string[]}`.
 *
 * The whole ordered list, never a delta: the engine compares the
 * submitted ids against the ids it considers user-manageable and
 * rejects anything that is not exactly that set. A list that could not
 * be a queue at all is refused here as `invalid_queue_order`; one that
 * is well-formed but stale reaches the engine and earns its own 400.
 *
 * 200 `{ok, items}` — the engine's new order, not the one requested.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleQueueReorder(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const wrong = rejectWrongType(res, parsed.itemIds, "itemIds", "array");
  if (wrong !== null) return wrong;
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(
    res,
    await reorderEngineQueue({ ...deps, sessionId, itemIds: parsed.itemIds }),
  );
}

/**
 * POST /api/queue/cancel — body `{itemId: string}`.
 *
 * 200 `{ok, item}` where the item is the engine's own cancelled record
 * (`status: "cancelled"`), so the client confirms the cancel from the
 * engine's answer rather than from the fact that it clicked.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleQueueCancel(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const wrong = rejectWrongType(res, parsed.itemId, "itemId", "string");
  if (wrong !== null) return wrong;
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(
    res,
    await cancelEngineQueueItem({ ...deps, sessionId, itemId: parsed.itemId }),
  );
}
