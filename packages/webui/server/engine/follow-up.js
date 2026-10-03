// webui/server/engine/follow-up.js
//
// Settings batch SB-4 (plan `doc/settings-batch-plan.md` §5 row 4): the
// follow-up message family — the one HTTP window over the two engine
// methods that already existed with nothing in front of them
// (`packages/local-runtime-v2/src/local/cli-service.ts`):
//
//   POST /api/follow-up  behavior=queue → cliService.enqueueMessage
//                       behavior=steer → cliService.steer
//
// WHY IT IS ONE ENDPOINT AND NOT TWO. The two actions are the two values
// of ONE setting (`webui-follow-up-behavior`), and the difference between
// them is a routing decision the composer has already made by the time it
// calls. Two endpoints would move that decision to the wire and leave the
// client with two calls to keep in step with a segmented control.
//
// THE OWNERSHIP GATE, which is the only interesting thing in this file.
// `enqueueMessage` and `steer` act on the session's ACTIVE turn, and
// webui's turns do not always live in this process:
//
//   - Under the `runtime` transport the turn runs in the webui process on
//     the SAME CliService the catalogue host exposes (`lib/runtime-host.js`
//     — "it shares the underlying CliService with the catalogue host"), so
//     a queue item is picked up by the dispatcher that is already running.
//   - Under the default `acp` transport the turn runs in an `mcode acp`
//     SUBPROCESS. This host's turn service would see an idle session, and
//     `submit({allowQueue:true})` on an idle session COMMITS THE QUEUE ITEM
//     AND WAKES THE DISPATCHER — a second live turn for a session that is
//     already running one. That is the failure `/api/send` spends four
//     claims and a 409 preventing (see `routes/chat.js#handleSend`:
//     "ten concurrent sends produced ten live engine processes").
//
// So the gate is `cliService.getActiveTurn(sessionId)`, which reports the
// session's active turn together with `locallyOwned` — the turn system's
// own word for "this process is the one executing it"
// (`turn-system/initialize.ts#inspection.activeTurn`). Three outcomes, and
// each is a DIFFERENT fact the client has to be told:
//
//   undefined             → 409 no_active_turn  (the browser's running flag
//                           and the engine disagree; the text is not lost,
//                           it comes back to the box)
//   locallyOwned === false → 409 turn_not_owned  (a turn is running, in
//                           another process; queueing would be a second turn)
//   locallyOwned === true  → the engine owns the turn here, proceed
//
// The gate is deliberately NOT a transport check. Reading
// `MCODE_WEBUI_TRANSPORT` would restate a fact the engine already reports,
// and it would be wrong the moment a provider or a route disagrees with the
// env var. See KNOWN DEBT 1 for what this costs today.
//
// READ-vs-WRITE. This is a write in the strict sense of `host.js` — it
// hands work to the engine — and it is reached by a user pressing a
// button, so it boots through `getEngineCatalogueHost()`. Nothing reads
// this family at page load, so the boot-on-read hazard `model-source.js`
// records (KNOWN DEBT 2) does not arise here.

import { projectSendAttachments } from "./streaming-send.js";

/**
 * The two engine actions, as the wire spells them. `off` is NOT here: it
 * is a client-side decision (render no send control), and a request that
 * carries it is a client that ignored the setting — a 400, not a silent
 * downgrade to "queue".
 *
 * @type {Readonly<Record<string, true>>}
 */
export const FOLLOW_UP_BEHAVIORS = Object.freeze({ queue: true, steer: true });

/**
 * The engine method each action needs. `member` is the host path both
 * rows share, so a future third action is a table edit.
 *
 * `getActiveTurn` is deliberately NOT a row: it is the gate, it runs for
 * BOTH actions, and a host that lacks it cannot answer the question the
 * gate asks — which is a 501 rather than an unverified guess.
 *
 * @type {Readonly<Record<string, Readonly<{member: "cliService", method: string}>>>}
 */
export const FOLLOW_UP_ACTIONS = Object.freeze({
  queue: Object.freeze({ member: "cliService", method: "enqueueMessage" }),
  steer: Object.freeze({ member: "cliService", method: "steer" }),
});

/** The action keys, in table order. */
export const FOLLOW_UP_ACTION_KEYS = Object.freeze(Object.keys(FOLLOW_UP_ACTIONS));

/** The member the ownership gate reads. */
export const FOLLOW_UP_GATE_METHOD = "getActiveTurn";

/**
 * The producer id the engine itself uses for a message typed by a person
 * into a turn that is already running
 * (`turn-system/agent-host/runner/contracts.ts#USER_STEERING_PRODUCERS`).
 * It is not a label webui invents: a user-steering producer survives Turn
 * teardown, so the message is requeued as a fresh query instead of being
 * dropped with the turn that was closing. Using any other id would send
 * the same text down the machine-injection path and lose it at the exit
 * boundary.
 *
 * @type {string}
 */
export const FOLLOW_UP_STEER_PRODUCER_ID = "composer-steer";

/**
 * The `source` the engine records for a message that came from an API
 * caller rather than from a channel, a cron or a teammate.
 *
 * @type {string}
 */
export const FOLLOW_UP_STEER_SOURCE = "api";

/**
 * The two refusals this family answers with, shared with the client so
 * both sides spell them identically. They are codes, not statuses: a 409
 * from `/api/send` means "this conversation is busy" and its `reason` is
 * the composer's banner vocabulary, while these describe what is wrong
 * with the ENGINE's turn record, which the composer renders with its own
 * two sentences (`webapp/lib/follow-up.ts#followUpFailureKey`).
 *
 * @type {Readonly<Record<string, true>>}
 */
export const FOLLOW_UP_CODES = Object.freeze({
  no_active_turn: true,
  turn_not_owned: true,
});

/**
 * @typedef {{ok: true, member: Function, host: object}} ResolvedFollowUpMember
 * @typedef {{ok: false, code: string, status: number, error: string}} FollowUpFailure
 */

/**
 * Read one `cliService` method off the booted catalogue host.
 *
 * `getHost` is the same flat injection seam `engine/model-source.js` uses:
 * production falls through to the process-wide getter, a test hands in a
 * fake host, and the route forwards its own optional fourth argument with
 * one spread.
 *
 * @param {object} options
 * @param {string} options.label Endpoint/method label for the failure text.
 * @param {string} options.method Method name on `host.cliService`.
 * @param {Function} [options.getHost]
 * @returns {Promise<ResolvedFollowUpMember|FollowUpFailure>}
 */
export async function resolveFollowUpMember(options) {
  const { label, method } = options;
  const getHost = options.getHost || (await import("./host.js")).getEngineCatalogueHost;
  let host;
  try {
    host = await getHost();
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
      error: `${label}: the engine catalogue host is not available`,
    };
  }
  if (typeof host.cliService?.[method] !== "function") {
    return {
      ok: false,
      code: "engine_member_unavailable",
      status: 501,
      error: `${label}: host.cliService.${method} is not a function`,
    };
  }
  return { ok: true, member: host.cliService[method].bind(host.cliService), host };
}

/**
 * Map a thrown engine error onto the HTTP surface.
 *
 * The engine's own statuses are forwarded (a 404 for a session it does
 * not hold, a 400 for a message it refuses). A `ConversationTurnRejectedError`
 * carries no status but does carry a stable `code` and a `reason` — that is
 * a refusal, so it becomes a 409 with both. Everything else becomes a 500
 * whose body carries no engine text: an exception string from an unknown
 * thrower is the one place a session id or a message could be echoed.
 *
 * @param {unknown} error
 * @param {string} label
 * @returns {FollowUpFailure}
 */
export function mapFollowUpError(error, label) {
  const status = error && typeof error.status === "number" ? error.status : 0;
  if (status >= 400 && status <= 599) {
    return {
      ok: false,
      code: typeof error.code === "string" ? error.code : "ENGINE_REFUSED",
      error: typeof error.message === "string" ? error.message : `${label} failed`,
      status,
    };
  }
  if (error && error.code === "CONVERSATION_TURN_REJECTED") {
    return {
      ok: false,
      code: "CONVERSATION_TURN_REJECTED",
      error:
        typeof error.reason === "string" && error.reason
          ? `${label}: the engine rejected the steering message (${error.reason})`
          : `${label}: the engine rejected the steering message`,
      status: 409,
    };
  }
  return { ok: false, code: "engine_error", error: `${label}: the engine call failed`, status: 500 };
}

/**
 * Project webui's resolved attachment records onto the queue's input
 * shape (`AttachmentInput` in `@mavis/protocol/local`).
 *
 * Delegated to `engine/streaming-send.js#projectSendAttachments` rather
 * than rewritten: the mime type it sends (`application/octet-stream`) and
 * the reason it sends that instead of a real one are a known limitation of
 * webui's upload pipeline, and a second projection would be a second place
 * for them to drift.
 *
 * @param {object[]} attachments Resolved attachments (`{path, name, size}`).
 * @param {object} attachmentsLib The `lib/attachments.js` namespace, for
 *   the per-turn cap. Injected by the caller, like the send path's.
 * @returns {object[]}
 */
export function projectFollowUpAttachments(attachments, attachmentsLib) {
  return projectSendAttachments(attachments, attachmentsLib);
}

/**
 * The steer-side projection. `ConversationAttachment` is a flat
 * `{type, filePath, fileName, mimeType}` record rather than the queue's
 * nested `{meta, local}` one, so the two actions cannot share a mapping.
 * The mime caveat above applies here too.
 *
 * @param {object[]} attachments Resolved attachments (`{path, name, size}`).
 * @returns {object[]}
 */
export function projectSteerAttachments(attachments) {
  return attachments.map((a) => ({
    type: "file",
    ...(a && a.path ? { filePath: a.path } : {}),
    ...(a && a.name ? { fileName: a.name } : {}),
    mimeType: "application/octet-stream",
  }));
}

/**
 * Bound on the per-send identity the client sends. The engine stores the
 * queue item's `clientRequestId` and steers on the message's
 * `idempotencyKey`, so an unbounded string from a browser would be stored
 * verbatim. 128 characters covers `clientId()` plus a counter and nothing
 * else; the value is only compared, never parsed.
 */
export const FOLLOW_UP_REQUEST_ID_MAX = 128;

/**
 * Accept a per-send identity, or `undefined`.
 *
 * The charset is deliberately narrow (letters, digits, dash, underscore,
 * colon, dot) because the value reaches an engine-side idempotency record
 * that several producers share, and an arbitrary string in that key space
 * is a record-shape hazard, not a feature. An over-long or otherwise
 * shaped value is DROPPED rather than rejected: the identity is an
 * optimisation against a double submit, not a contract the message
 * depends on, and refusing a message over it would be a worse lie than
 * sending it once.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizeFollowUpRequestId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FOLLOW_UP_REQUEST_ID_MAX) return undefined;
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The ownership gate, as a total function over what the engine reported.
 *
 * Split out because the three outcomes must stay distinct all the way to
 * the client, and a test can pin them without a host.
 *
 * @param {unknown} active `getActiveTurn`'s answer: `{turnId, busyReason,
 *   locallyOwned}` or `undefined`.
 * @returns {FollowUpFailure|null} `null` means "this process owns the
 *   turn, proceed".
 */
export function classifyActiveTurn(active) {
  if (!active || typeof active !== "object") {
    return {
      ok: false,
      code: "no_active_turn",
      status: 409,
      error:
        "POST /api/follow-up: the engine reports no running turn for this session, so the message was not queued",
    };
  }
  if (active.locallyOwned !== true) {
    return {
      ok: false,
      code: "turn_not_owned",
      status: 409,
      error:
        "POST /api/follow-up: the running turn belongs to another engine process, which holds this session's queue",
    };
  }
  return null;
}

/**
 * Hand one follow-up message to the engine.
 *
 * The order of the checks is the order of the costs: the cheap
 * validations that need no runtime run first, then the gate (one engine
 * read), then the action itself. Nothing here is reachable while no turn
 * is running, and the client only calls it in that case.
 *
 * @param {object} options
 * @param {unknown} options.behavior `"queue"` or `"steer"`.
 * @param {unknown} options.sessionId The ENGINE session id (`mvs_…`), never
 *   a webui session id.
 * @param {unknown} options.content Message text.
 * @param {object[]} [options.attachments] Resolved attachments.
 * @param {object} [options.attachmentsLib] The `lib/attachments.js`
 *   namespace, forwarded to the queue's attachment projection.
 * @param {unknown} [options.requestId] Per-send identity.
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|FollowUpFailure>}
 */
export async function sendEngineFollowUp(options = {}) {
  const endpoint = "POST /api/follow-up";
  const behavior = typeof options.behavior === "string" ? options.behavior : "";
  if (!FOLLOW_UP_BEHAVIORS[behavior]) {
    return {
      ok: false,
      code: "invalid_follow_up_behavior",
      status: 400,
      error: `${endpoint}: behavior must be one of ${FOLLOW_UP_ACTION_KEYS.join(", ")}`,
    };
  }
  const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  if (!sessionId) {
    return {
      ok: false,
      code: "session_required",
      status: 400,
      error: `${endpoint}: sessionId is required`,
    };
  }
  const content = typeof options.content === "string" ? options.content.trim() : "";
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  if (!content && attachments.length === 0) {
    return {
      ok: false,
      code: "follow_up_empty",
      status: 400,
      error: `${endpoint}: content or an attachment is required`,
    };
  }
  const requestId = normalizeFollowUpRequestId(options.requestId);

  const gate = await resolveFollowUpMember({
    label: endpoint,
    method: FOLLOW_UP_GATE_METHOD,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!gate.ok) return gate;
  let active;
  try {
    active = await gate.member(sessionId);
  } catch (error) {
    return mapFollowUpError(error, `${endpoint} (${FOLLOW_UP_GATE_METHOD})`);
  }
  const refused = classifyActiveTurn(active);
  if (refused) return refused;

  const action = FOLLOW_UP_ACTIONS[behavior];
  const resolved = await resolveFollowUpMember({
    label: endpoint,
    method: action.method,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!resolved.ok) return resolved;

  if (behavior === "queue") {
    let queued;
    try {
      queued = await resolved.member({
        id: sessionId,
        content,
        ...(attachments.length > 0
          ? { attachments: projectFollowUpAttachments(attachments, options.attachmentsLib) }
          : {}),
        ...(requestId ? { clientRequestId: requestId } : {}),
      });
    } catch (error) {
      return mapFollowUpError(error, `${endpoint} (${action.method})`);
    }
    // The response reports the ENGINE's commit, not the request: an item
    // id and a position the engine never recorded would send the user
    // looking for a queue entry that does not exist.
    const record = queued && typeof queued === "object" ? queued : {};
    return {
      ok: true,
      payload: {
        ok: true,
        behavior: "queue",
        itemId: typeof record.itemId === "string" ? record.itemId : null,
        position: typeof record.position === "number" ? record.position : null,
        status: typeof record.status === "string" ? record.status : null,
      },
    };
  }

  let steered;
  try {
    steered = await resolved.member({
      sessionId,
      source: FOLLOW_UP_STEER_SOURCE,
      message: {
        content,
        ...(attachments.length > 0 ? { attachments: projectSteerAttachments(attachments) } : {}),
      },
      producerId: FOLLOW_UP_STEER_PRODUCER_ID,
      idempotencyKey: requestId ?? `${sessionId}:follow-up`,
    });
  } catch (error) {
    return mapFollowUpError(error, `${endpoint} (${action.method})`);
  }
  const outcome = steered && typeof steered === "object" ? steered : {};
  return {
    ok: true,
    payload: {
      ok: true,
      behavior: "steer",
      turnId: typeof outcome.turnId === "string" ? outcome.turnId : null,
      mode: typeof outcome.mode === "string" ? outcome.mode : null,
    },
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. The default `acp` transport cannot take a follow-up, and refuses
//    honestly. The running turn lives in an `mcode acp` subprocess, so
//    `getActiveTurn` reports it with `locallyOwned: false` and this
//    family answers 409 `turn_not_owned`; the composer restores the text
//    and says why. The alternative — queueing into an engine that is not
//    running the turn — was measured, not assumed: `submitQueued` commits
//    the item and then wakes the dispatcher, which would start a SECOND
//    turn for a session that already has one. When the chat path finishes
//    its move to the in-process `runtime` transport, this gate starts
//    passing on its own and nothing here has to change; no transport
//    check was added, precisely so that moment needs no edit.
//
// 2. The queue's UI does not exist yet. A queued follow-up is committed
//    with an item id and a position that nothing displays, and the queue
//    cannot be inspected, reordered or cancelled from the browser. That is
//    PB-13's scope, and until it lands the honest statement is that a
//    queued message is invisible until the running turn ends and the
//    dispatcher picks it up.
//
// 3. Steer reports no position and no receipt. `ConversationSteerResult`
//    is an admission ACK (`turnId` + `mode`); whether the running agent
//    actually read the text before its next step is the engine's
//    internal, and the response does not claim otherwise.
