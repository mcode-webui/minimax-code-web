// webui/server/engine/message-edit.js
//
// PB-15 (`doc/placeholder-batch-plan.md` §7 row G-3, §9 row 14): the engine
// facade for MESSAGE-LEVEL EDIT and REWIND — the two things a user does when
// the message they already sent was the wrong message.
//
//   POST /api/messages/edit   → cliService.editSessionMessage
//   POST /api/messages/rewind → cliService.rewindSession
//
// WHY BOTH ENDPOINTS EXIST AND NEITHER IS INVENTED. The engine has carried
// the whole conversation-mutation surface all along
// (`packages/local-runtime-v2/src/local/cli-service.ts:244` / `:254`):
//
//   rewindSession       → {rewound, deletedMessageIds, displayRevision, …}
//   editSessionMessage  → {rewound, turnId, userMessageId, deletedMessageIds, …}
//
// The plan called this 3/3 ready on the engine and zero UI on the webapp side.
// What was missing was the window and the coordinate.
//
// THE COORDINATE IS THE POINT. Both engine methods take a `userMessageId`,
// and neither can guess it: it is the engine's own `msg_id` for the user's
// message row. webui's transcript carries that id in a `§§ user_msg=<id>`
// marker written by `server/lib/transcript.js#messagesToChatLines` and
// decoded by `webapp/lib/transcript.ts#decodeTranscript` — the same
// mechanism `§§ turn_msg=<id>` already uses for the turn-diff card. A user
// message with no marker renders no edit affordance at all, because a row
// with no id has no honest edit target.
//
// WHY THE SESSION ID IS NOT TAKEN FROM THE BODY. Same reason as
// `/api/send`, `/api/follow-up` and the whole `/api/queue` family: the client
// knows the webui session it is looking at, the server holds the engine
// mapping in `ctx.cs.mcodeSessionId`. A body-supplied session id would be an
// unvalidated engine identifier the user could aim at a conversation this
// tab is not showing — and this family is destructive, so "which
// conversation" is the one question that must not be the caller's to get
// wrong.
//
// BOTH CALLS MAY BOOT A RUNTIME. The rule `engine/host.js` records — a READ
// may not boot, a WRITE may — applies unchanged here: the user pressed a
// button on a message, and asking the engine to do it is the whole point.
// There is no read in this family.
//
// `clientRequestId` IS MINTED HERE, NOT BY THE BROWSER. The engine requires
// one and uses it as the operation's idempotency key; the TUI mints it from
// its own operation ledger. webui has no such ledger for this family, and a
// browser-minted id would be an engine identifier arriving from an
// untrusted boundary for no gain — the route is not retried by any client,
// and the inline editor disables its own confirm while a call is in flight.
// Each press therefore gets one fresh id, which is exactly the "two presses,
// two turns" behaviour a user asking twice should get.
//
// `rewindTurnDiff` IS TRUE, matching the TUI's own edit/rewind calls
// (`packages/tui/src/tui/controller/product/session-mutation-flow.ts:447`).
// Discarding a turn and keeping the files it wrote would leave the workspace
// describing a conversation that no longer exists. The engine reports what
// happened per turn (`turnDiffRewind.status`, `revertedTurnIds`,
// `errorCode`) and that outcome is projected onto the wire rather than
// collapsed into a boolean.

import { randomUUID } from "node:crypto";
import { mapFollowUpError } from "./follow-up.js";

/** The endpoint label every failure line starts with. */
const ENDPOINT = "/api/messages";

/**
 * The two engine methods, as one table.
 *
 * `host.cliService` is the member every row shares, so a third action would
 * be a table edit rather than a new resolution path.
 *
 * @type {Readonly<Record<string, Readonly<{member: "cliService", method: string}>>>}
 */
export const MESSAGE_EDIT_ACTIONS = Object.freeze({
  edit: Object.freeze({ member: "cliService", method: "editSessionMessage" }),
  rewind: Object.freeze({ member: "cliService", method: "rewindSession" }),
});

/**
 * Locate the host (booting if needed) and bind one engine method off it.
 *
 * A missing method is a 501 rather than a guess: a host without
 * `editSessionMessage` cannot be asked to edit a message, and pretending
 * otherwise would produce a 500 that says nothing about which layer failed.
 *
 * @param {"edit"|"rewind"} action
 * @param {Function} [getHost] The `getHost` seam — production leaves it
 *   unset, `test/routes/message-edit.test.js` passes a fake.
 * @returns {Promise<{ok: true, member: Function}|{ok: false, code: string, status: number, error: string}>}
 */
async function bindMessageEditMethod(action, getHost) {
  const { getEngineCatalogueHost } = await import("./host.js");
  let host;
  try {
    host = getHost ? await getHost() : await getEngineCatalogueHost();
  } catch (e) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: e && e.message ? e.message : String(e),
    };
  }
  if (!host) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${ENDPOINT}: the engine catalogue host is not available`,
    };
  }
  const { method } = MESSAGE_EDIT_ACTIONS[action];
  if (typeof host.cliService?.[method] !== "function") {
    return {
      ok: false,
      code: "engine_member_unavailable",
      status: 501,
      error: `${ENDPOINT}: host.cliService.${method} is not a function`,
    };
  }
  return { ok: true, member: host.cliService[method].bind(host.cliService) };
}

/**
 * Normalise the message coordinate every action in this family shares.
 *
 * The engine selects on an exact `msg_id`, so anything that is not a
 * non-empty string has no target at all. Refusing here names the real
 * problem — the client sent no message id — instead of forwarding `""` and
 * letting the engine answer with a message written for its own caller.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeMessageId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `POST /api/messages/edit` — replace what a user message said and have the
 * engine re-run the turn from it.
 *
 * The engine's `editSessionMessage` is ATOMIC: it rewinds to the message,
 * rewrites it, and resubmits in one operation, which is why this route never
 * chains a rewind behind it.
 *
 * @param {object} options
 * @param {string} options.sessionId The ENGINE session id, never from the body.
 * @param {unknown} options.userMessageId
 * @param {unknown} options.content
 * @param {boolean} [options.rewindTurnDiff]
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function editEngineMessage(options) {
  const userMessageId = normalizeMessageId(options.userMessageId);
  if (!userMessageId) {
    return {
      ok: false,
      code: "message_id_required",
      status: 400,
      error: `${ENDPOINT}/edit: userMessageId is required`,
    };
  }
  if (typeof options.content !== "string" || options.content.trim().length === 0) {
    return {
      ok: false,
      code: "message_text_required",
      status: 400,
      error: `${ENDPOINT}/edit: content must be a non-empty string`,
    };
  }
  const bound = await bindMessageEditMethod("edit", options.getHost);
  if (!bound.ok) return bound;
  let answer;
  try {
    answer = await bound.member({
      id: options.sessionId,
      userMessageId,
      clientRequestId: randomUUID(),
      content: options.content,
      rewindTurnDiff: options.rewindTurnDiff !== false,
    });
  } catch (error) {
    return mapFollowUpError(error, `${ENDPOINT}/edit (editSessionMessage)`);
  }
  return { ok: true, payload: { ok: true, ...projectEditResult(answer) } };
}

/**
 * `POST /api/messages/rewind` — discard everything after a user message and
 * stop there.
 *
 * The engine's rewind does NOT resubmit: it returns which messages it
 * deleted and stops. Resending is a separate act, and the client owns it —
 * that separation is why the two endpoints exist at all rather than one
 * endpoint doing both.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {unknown} options.userMessageId
 * @param {boolean} [options.rewindTurnDiff]
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function rewindEngineSession(options) {
  const userMessageId = normalizeMessageId(options.userMessageId);
  if (!userMessageId) {
    return {
      ok: false,
      code: "message_id_required",
      status: 400,
      error: `${ENDPOINT}/rewind: userMessageId is required`,
    };
  }
  const bound = await bindMessageEditMethod("rewind", options.getHost);
  if (!bound.ok) return bound;
  let answer;
  try {
    answer = await bound.member({
      id: options.sessionId,
      userMessageId,
      clientRequestId: randomUUID(),
      rewindTurnDiff: options.rewindTurnDiff !== false,
    });
  } catch (error) {
    return mapFollowUpError(error, `${ENDPOINT}/rewind (rewindSession)`);
  }
  return { ok: true, payload: { ok: true, ...projectRewindResult(answer) } };
}

/**
 * Project the edit answer.
 *
 * `rewound` is passed through as the engine reported it and is NOT
 * defaulted to `true`: the engine has a `rewound:false` path, and a server
 * that answered `true` for a no-op would tell the user their message was
 * replaced when it was not. `deletedMessageIds` is the honest signal for how
 * much of the conversation the edit discarded — the client renders it as a
 * count and never as "your conversation was reset".
 *
 * @param {unknown} answer
 * @returns {{rewound: boolean, turnId?: string, userMessageId?: string, deletedCount: number}}
 */
export function projectEditResult(answer) {
  const record = answer && typeof answer === "object" ? answer : {};
  const out = { rewound: record.rewound === true };
  if (typeof record.turnId === "string") out.turnId = record.turnId;
  if (typeof record.userMessageId === "string") out.userMessageId = record.userMessageId;
  out.deletedCount = Array.isArray(record.deletedMessageIds)
    ? record.deletedMessageIds.length
    : 0;
  return out;
}

/**
 * Project the rewind answer, including the per-turn file outcome.
 *
 * `turnDiffRewind` is reported, not swallowed: the engine can say the
 * history rewound while a turn's files were skipped, and a client that only
 * saw `rewound:true` would draw a workspace the engine never restored.
 *
 * @param {unknown} answer
 * @returns {{rewound: boolean, deletedCount: number, turnDiffRewind: object|null}}
 */
export function projectRewindResult(answer) {
  const record = answer && typeof answer === "object" ? answer : {};
  const out = {
    rewound: record.rewound === true,
    deletedCount: Array.isArray(record.deletedMessageIds)
      ? record.deletedMessageIds.length
      : 0,
    turnDiffRewind: null,
  };
  const diff = record.turnDiffRewind;
  if (diff && typeof diff === "object" && typeof diff.status === "string") {
    out.turnDiffRewind = { status: diff.status };
    if (Array.isArray(diff.revertedTurnIds)) {
      out.turnDiffRewind.revertedTurnIds = diff.revertedTurnIds.filter(
        (value) => typeof value === "string",
      );
    }
    if (typeof diff.errorCode === "string") {
      out.turnDiffRewind.errorCode = diff.errorCode;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. `getSessionRewindPreview` is not exposed. The engine can list which
//    turns a rewind would revert and which files each one touched, and the
//    desktop asks before it destroys. This slice ships the destructive act
//    with the desktop's inline-editor confirmation standing in for that
//    dialog; a preflight that the user must click through twice is a separate
//    decision, and half of it (a preview that can be wrong about what will
//    actually be deleted) is worse than none.
//
// 2. The rewound-from resend goes through `/api/send`, not through the
//    engine's edit. `editSessionMessage` is the atomic path and is used
//    whenever the text changed; rewind + send is the path taken when the user
//    confirmed the text unchanged, because re-running an identical message
//    through the edit path would mint a second engine operation for no
//    change to the text.
//
// 3. Attachments on an edited message are dropped. The engine accepts
//    `attachments` on `editSessionMessage` and webui's edit carries none, so
//    editing a message that had an attachment resends the text without it.
//    Projecting the transcript's attachment references back onto the editor
//    is real work and is not invented here.