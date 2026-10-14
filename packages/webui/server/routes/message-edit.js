// webui/server/routes/message-edit.js
//
// The HTTP shape for PB-15's message-level edit / rewind:
//
//   POST /api/messages/edit   — body `{userMessageId, content}`
//   POST /api/messages/rewind — body `{userMessageId}`
//
// This file parses, validates and writes. Which engine method each route
// reaches, what is projected off the answer and how an engine refusal
// becomes a status code all live in `../engine/message-edit.js`, the same
// split `routes/queue.js` keeps.
//
// WHY TWO ROUTES AND NOT ONE WITH A DISCRIMINATOR. The two bodies differ in
// a way a user can see: rewind has no text, and an endpoint that took an
// optional text would have to decide whether a missing text meant "rewind
// and resend the old one" or "this request was malformed". That is a
// decision this layer must not make on the user's behalf.
//
// WHY SESSION ID IS NOT IN EITHER BODY. `ctx.cs.mcodeSessionId` is the only
// source, for the same reason `/api/follow-up` and `/api/queue` take it from
// the server's conversation state: this family deletes history, and a
// body-supplied session id would let a caller aim that deletion at a
// conversation the tab is not showing.

import { readJson } from "../lib/read-json.js";
import {
  editEngineMessage,
  rewindEngineSession,
} from "../engine/message-edit.js";

/**
 * Write one answer, whether it succeeded or not.
 *
 * Same shape as the queue family's writer, kept local for the same reason
 * that one is: exporting a four-line helper across a family boundary to save
 * four lines couples two route files that have no other reason to change
 * together.
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
 * Without one there is no conversation whose history this could touch, and
 * the honest answer names that rather than reporting a failure that looks
 * like the engine's.
 *
 * @param {object} res
 * @param {object} ctx
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
        "message edit: this tab has no live conversation with an engine session, so there is no message to edit",
    }),
  );
  return null;
}

/**
 * Reject a body field that arrived with the wrong type.
 *
 * `readJson` normalises an absent body to `{}`, so a type is the only thing
 * that can be wrong. Treating `{"userMessageId": 7}` as "no message id"
 * would turn a client's bug into a refusal that names the wrong problem.
 *
 * @param {object} res
 * @param {unknown} value
 * @param {string} field
 * @returns {number|null} The status written, or `null` when acceptable.
 */
function rejectWrongType(res, value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return null;
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      code: "bad_field_type",
      error: `${field} must be a string`,
    }),
  );
  return 400;
}

/**
 * POST /api/messages/edit — body `{userMessageId: string, content: string}`.
 *
 * 200 `{ok, rewound, turnId?, userMessageId?, deletedCount}`.
 *
 * Every handler takes an optional FOURTH argument forwarded to the engine
 * facade's `getHost` seam — nothing in production, a fake host in
 * `test/routes/message-edit.test.js`. `app.js#invokeHandler` passes three,
 * so the seam costs production nothing and keeps the suite hermetic.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleMessageEdit(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const wrongId = rejectWrongType(res, parsed.userMessageId, "userMessageId");
  if (wrongId !== null) return wrongId;
  const wrongText = rejectWrongType(res, parsed.content, "content");
  if (wrongText !== null) return wrongText;
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(
    res,
    await editEngineMessage({
      ...deps,
      sessionId,
      userMessageId: parsed.userMessageId,
      content: parsed.content,
    }),
  );
}

/**
 * POST /api/messages/rewind — body `{userMessageId: string}`.
 *
 * 200 `{ok, rewound, deletedCount, turnDiffRewind}` where `turnDiffRewind`
 * is `null` when the engine reported no file outcome — never a fabricated
 * "reverted".
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleMessageRewind(req, res, ctx, deps = {}) {
  const parsed = await readJson(req);
  const wrongId = rejectWrongType(res, parsed.userMessageId, "userMessageId");
  if (wrongId !== null) return wrongId;
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(
    res,
    await rewindEngineSession({
      ...deps,
      sessionId,
      userMessageId: parsed.userMessageId,
    }),
  );
}