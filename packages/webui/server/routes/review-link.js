// webui/server/routes/review-link.js
//
// PB-16 (`doc/placeholder-batch-plan.md` §6.3): the wire shape for the
// 「Review」 button on the 「已编辑 N 个文件」 card.
//
//   GET /api/review-link?cid=<webui session id>
//
// This file is the HTTP shape and nothing else. Which engine methods the read
// reaches, the three-state host gate, the record projection and the error
// mapping live in `../engine/review-link.js` — the same split
// `routes/queue.js` keeps for the queue family.
//
// WHY `?cid=` AND NOT AN ENGINE SESSION ID. The browser knows which webui
// conversation it is showing and nothing else; `cid` is what the shared
// middleware (`app.js`, `getCidFromReq`) uses to look up the per-client state,
// and `ctx.cs.mcodeSessionId` is the engine session that state holds. The
// route therefore NEVER reads an engine session id from the request, for the
// same reason `/api/queue` and `/api/follow-up` do not: a client-supplied
// engine id is one more unvalidated identifier on the wire, and one the user
// could aim at a conversation this tab is not showing. The review link is
// then resolved from THAT session's own workspace — so a tab cannot read
// another conversation's review even by guessing.
//
// Wire contract:
//   link recorded        200 { ok: true, reviewLink: {vendor,url,number,branch,origin,recordedAt}, reason: null, branch }
//   nothing recorded    200 { ok: true, reviewLink: null, reason, branch } — the common case, NOT an error
//   no engine session    400 { ok: false, code: "no_active_conversation" }
//   host absent          503 { ok: false, code: "engine_host_unavailable" }
//   member absent        501 { ok: false, code: "engine_member_unavailable" | "engine_git_metadata_unavailable" | "engine_session_reader_unavailable" }
//   capability declared away
//                         501 { ok: false, code: "engine_capability_not_supported", … }
//
// A 501 and a 503 are never flattened into a "no review" answer: the client
// draws a disabled button with a reason for a genuine absence, and that reason
// must be true. A runtime that failed to boot has no review to report, and
// saying so would be the fake-empty shape this repository refuses to
// reintroduce (#110).

import { readEngineReviewLink } from "../engine/review-link.js";

/**
 * Write one answer, whether it succeeded or not.
 *
 * Written here rather than imported from `routes/queue.js#writeResult` for the
 * reason that helper is local to that file: exporting a five-line writer across
 * a family boundary would couple two route files that have no other reason to
 * change together.
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
  // A refusal that already carries a full payload (the shared 501
  // `engine_capability_not_supported` body, whose `capability` /
  // `provider` / `missing` fields the frontend reads) is sent verbatim.
  // Rebuilding it from `code` + `error` here would strip exactly the fields
  // that make the refusal actionable.
  if (result.payload) {
    res.end(JSON.stringify({ ok: false, ...result.payload }));
    return status;
  }
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
 * Same rule and same wording family as `routes/queue.js`: the review link is
 * looked up for a CONVERSATION, and this tab has none to look it up for. An
 * empty answer would instead claim "there is no review", which is a different
 * sentence and not one the server has established.
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
        "the review link: this tab has no live conversation with an engine session, so there is no workspace to review",
    }),
  );
  return null;
}

/**
 * `GET /api/review-link` — the review recorded for this session's workspace.
 *
 * The optional FOURTH argument is forwarded to the engine facade's `getHost`
 * seam — nothing in production, a fake host in
 * `test/routes/review-link.test.js`. `app.js#invokeHandler` passes three
 * arguments, so the seam costs production nothing.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {object} [deps]
 * @returns {Promise<number>} The status written.
 */
export async function handleReviewLink(req, res, ctx, deps = {}) {
  const sessionId = requireEngineSessionId(res, ctx);
  if (!sessionId) return 400;
  return writeResult(
    res,
    await readEngineReviewLink({
      sessionId,
      ...(deps.getHost ? { getHost: deps.getHost } : {}),
    }),
  );
}