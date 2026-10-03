// webui/server/routes/follow-up.js
//
// The follow-up message family (settings batch SB-4, plan
// `doc/settings-batch-plan.md` §5 row 4):
//
//   POST /api/follow-up  — hand a message to the engine while a turn runs
//
// This file is the HTTP shape and nothing else. The behaviour whitelist,
// the ownership gate, the two engine projections and the error mapping
// live in `../engine/follow-up.js`, which is where every other family
// keeps them. What stays here is what only an HTTP layer can own: the
// request body read, the attachment resolution (client paths are
// untrusted, exactly as in `routes/chat.js#handleSend`), the status line
// and the JSON body.
//
// WHY THE SESSION ID IS NOT TAKEN FROM THE BODY. `/api/send` reads the
// engine session id from the per-cid conversation state
// (`ctx.cs.mcodeSessionId`) and the client sends only text. A follow-up is
// the same message to the same conversation, so it takes the same source
// for the same two reasons: a client that names its own session could aim
// a message at a conversation the tab is not showing, and the id in the
// body would be one more unvalidated engine identifier on the wire.
//
// The consequence is honest rather than convenient: a browser that has no
// live conversation for this cid has nothing to follow up on, and gets a
// 400 naming that, instead of a queued message in a session nobody is
// looking at.

import { readJson } from "../lib/read-json.js";
import * as attachmentsLib from "../lib/attachments.js";
import { sendEngineFollowUp } from "../engine/follow-up.js";

/**
 * Write one answer, whether it succeeded or not. The engine facade
 * already decided the status and the code; this only serialises it and
 * never invents a field the facade did not produce.
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
 * Reject an optional field that is present with the wrong type.
 *
 * `lib/read-json.js` already normalises an absent body to `{}`, so the
 * only thing that CAN arrive wrong is a field's type — and silently
 * treating `{"behavior": 7}` as "no behaviour given" would turn a client's
 * bug into a 400 that names the wrong problem.
 *
 * @param {object} res
 * @param {unknown} value
 * @param {string} field
 * @param {string} expected `"string"`, `"boolean"` or `"array"`.
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
 * POST /api/follow-up — queue or steer one message into the running turn.
 *
 * Body: `{ "behavior": "queue" | "steer", "content": string,
 *          "attachments"?: string[], "requestId"?: string }`.
 *
 * 200 `{ok:true, behavior, itemId, position, status}` for a queue, or
 * `{ok:true, behavior, turnId, mode}` for a steer — the engine's own
 * answer, never an echo of the request.
 *
 * 400 `invalid_follow_up_behavior` for anything but the two engine
 * actions. The OFF position never reaches here: it is the composer
 * rendering no send control, and a request that carries it is a client
 * that ignored the setting, not a user choice to honour here.
 *
 * 409 `no_active_turn` / `turn_not_owned` — the two facts the ownership
 * gate can find (see `../engine/follow-up.js`). Both are refusals: the
 * message was NOT delivered, and the composer puts the text back.
 *
 * Every handler takes an optional FOURTH argument forwarded to the engine
 * facade's option bag (`{getHost, attachmentsLib}` — nothing in
 * production, a fake host in `test/routes/follow-up.test.js`).
 * `app.js#invokeHandler` passes three arguments, so the seam costs
 * production nothing and keeps the suite hermetic: no runtime boot, no
 * network, no tmpdir.
 */
export async function handleFollowUp(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const wrongBehavior = rejectWrongType(res, parsed.behavior, "behavior", "string");
  if (wrongBehavior !== null) return wrongBehavior;
  const wrongContent = rejectWrongType(res, parsed.content, "content", "string");
  if (wrongContent !== null) return wrongContent;
  const wrongAttachments = rejectWrongType(res, parsed.attachments, "attachments", "array");
  if (wrongAttachments !== null) return wrongAttachments;
  const wrongRequestId = rejectWrongType(res, parsed.requestId, "requestId", "string");
  if (wrongRequestId !== null) return wrongRequestId;

  // Same validation the send route runs, same reason: a path from the
  // browser is untrusted, and a silently dropped chip is the bug this
  // replaced. A rejected or dropped path is still a delivery, so the
  // response says how many — the message is not refused for a bad chip.
  const { attachments } = attachmentsLib.resolveAttachments(parsed.attachments);
  const sessionId = (ctx && ctx.cs && ctx.cs.mcodeSessionId) || "";
  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: false,
        code: "no_active_conversation",
        error:
          "POST /api/follow-up: this tab has no live conversation with an engine session, so there is nothing to follow up on",
      }),
    );
  }
  return writeResult(
    res,
    await sendEngineFollowUp({
      ...deps,
      behavior: parsed.behavior,
      sessionId,
      content: parsed.content,
      attachments,
      requestId: parsed.requestId,
      attachmentsLib,
    }),
  );
}
