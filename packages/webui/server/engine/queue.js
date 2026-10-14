// webui/server/engine/queue.js
//
// PB-13 (`doc/placeholder-batch-plan.md` §5 row 5, G-1): the engine
// facade for the message QUEUE — the second half of the follow-up family
// SB-4 opened, and the half that makes a queued message visible.
//
//   GET  /api/queue            → cliService.listQueueMessages
//   POST /api/queue/reorder    → cliService.reorderQueue
//   POST /api/queue/cancel     → cliService.deleteQueueItem
//
// WHY ALL THREE EXIST AND NONE IS INVENTED. The engine has always had
// the full queue surface
// (`packages/local-runtime-v2/src/local/cli-service.ts`, the five methods
// that delegate to `options.applications.queue`):
//
//   listQueueMessages → {items, paused, pendingCount}
//   getQueueItem      → {item}
//   updateQueueItem   → {item}
//   reorderQueue      → {items}
//   deleteQueueItem   → {item}   (it calls `queue.cancel`, so DELETE is
//                                  what "cancel" means in this engine)
//
// PB-13's plan line called this 7/7 ready and the webapp side zero UI;
// SB-4 opened a window over the two WRITE-mostly methods and left the
// queue itself unreadable. This file is the window over the three the
// panel needs. `getQueueItem` and `updateQueueItem` are deliberately not
// exposed yet: a single item is already in the list answer, and editing a
// queued message's text is a slice of its own (see KNOWN DEBT 1).
//
// THE GATE IS SHARED WITH SB-4, NOT A SECOND ONE. `QueueApplication`
// opens every method with `requireMutableSession(req.id)`, so a session
// the engine does not hold in THIS process cannot be listed, reordered or
// cancelled — the queue of a turn that runs in an `mcode acp` subprocess
// lives in that subprocess. Rather than let that surface as an opaque
// engine error, the same `getActiveTurn` fact SB-4's ownership gate reads
// is read here first, and it decides the SHAPE of the answer:
//
//   - a READ that cannot reach the queue answers 200 with
//     `reachable:false` and a reason, because a panel that polls every
//     few seconds must not raise an error banner for a fact that is
//     simply "the queue is not in this process";
//   - a WRITE that cannot reach the queue answers 409
//     `queue_not_here`, because a user who pressed "cancel" has to be
//     told the cancel did NOT happen.
//
// The two shapes differ deliberately, and that difference is the whole
// reason the gate is here rather than left to the engine.
//
// READS MAY NOT BOOT A RUNTIME. `GET /api/queue` goes through
// `peekEngineCatalogueHost()`, not `getEngineCatalogueHost()`. The
// reason is recorded at length in `engine/host.js`: a read that boots
// the runtime turns a page's first paint into a multi-second stall,
// silently, and PB-1 already paid for it with a 10 s `/api/state`
// timeout. A panel that finds no host answers `reachable:false` and
// the client draws the honest note instead. The two WRITES may boot,
// because the user pressed a button and asking is the whole point.

import { mapFollowUpError } from "./follow-up.js";

/** The endpoint label every failure line starts with. */
const ENDPOINT = "/api/queue";

/**
 * The three engine methods, as one table.
 *
 * `host.cliService` is the same member every row shares, so a fourth
 * action is a table edit rather than a new resolution path.
 *
 * @type {Readonly<Record<string, Readonly<{member: "cliService", method: string}>>>}
 */
export const QUEUE_ACTIONS = Object.freeze({
  list: Object.freeze({ member: "cliService", method: "listQueueMessages" }),
  reorder: Object.freeze({ member: "cliService", method: "reorderQueue" }),
  cancel: Object.freeze({ member: "cliService", method: "deleteQueueItem" }),
});

/**
 * The gate method, shared verbatim with SB-4
 * (`engine/follow-up.js#FOLLOW_UP_GATE_METHOD`). It is NOT a row in
 * `QUEUE_ACTIONS`: it runs for every action, and a host that cannot
 * answer it cannot answer any of them.
 */
export const QUEUE_GATE_METHOD = "getActiveTurn";

/**
 * The one code the queue is unreachable under.
 *
 * It is deliberately the SAME word SB-4 uses for the same fact
 * (`engine/follow-up.js#FOLLOW_UP_CODES.turn_not_owned` is that family's
 * spelling; both are "the running turn belongs to another engine
 * process"). One fact, one code, one sentence the user can act on, in
 * both families — the composer already words it.
 *
 * @type {string}
 */
export const QUEUE_TURN_NOT_HERE = "turn_not_here";

/**
 * Read one queue method off the host, choosing the boot policy by hand.
 *
 * `read` is the argument rather than a boolean flag baked into the
 * table, because the boot policy is the ONE decision that differs
 * between the three actions and it is worth naming at every call site
 * instead of being inferred from which row was looked up.
 *
 * @param {object} options
 * @param {keyof QUEUE_ACTIONS} options.action
 * @param {Function} [options.getHost] Boot policy: production leaves it
 *   unset, and the resolution picks peek for `list` and boot for the
 *   writes. A test passes a fake and the policy becomes irrelevant.
 * @returns {Promise<{ok: true, member: Function, host: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function resolveQueueHost(options) {
  if (options.getHost) return options.getHost();
  const { peekEngineCatalogueHost, getEngineCatalogueHost } = await import("./host.js");
  // A READ peeks (no boot, see the file header). A WRITE boots: the
  // user asked for something to change and the engine may need to come
  // up to do it.
  return options.read === true ? peekEngineCatalogueHost() : getEngineCatalogueHost();
}

/**
 * Locate the host under one boot policy and report what it could not do.
 *
 * @param {object} options
 * @param {boolean} [options.read] Peek instead of boot.
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, host: object}|{ok: false, code: string, status: number, error: string}>}
 */
async function requireQueueHost(options) {
  let host;
  try {
    host = await resolveQueueHost(options);
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
  return { ok: true, host };
}

/**
 * Bind one engine method off the located host, or say which one is
 * missing. A 501 rather than an unverified guess: a host that lacks
 * `listQueueMessages` cannot be asked about a queue.
 *
 * @param {object} host
 * @param {keyof QUEUE_ACTIONS} action
 * @returns {{ok: true, member: Function}|{ok: false, code: string, status: number, error: string}}
 */
export function bindQueueMethod(host, action) {
  const method = QUEUE_ACTIONS[action].method;
  if (typeof host?.cliService?.[method] !== "function") {
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
 * The shared reachability gate, as a total function.
 *
 * @param {unknown} active What `getActiveTurn` reported.
 * @returns {null|{code: string, error: string}} `null` means the queue is
 *   in this process and the caller may proceed.
 */
export function classifyQueueReachability(active) {
  if (!active || typeof active !== "object") {
    return {
      code: QUEUE_TURN_NOT_HERE,
      error: `${ENDPOINT}: the engine reports no running turn for this session, so its queue is not in this process`,
    };
  }
  if (active.locallyOwned !== true) {
    return {
      code: QUEUE_TURN_NOT_HERE,
      error: `${ENDPOINT}: the running turn belongs to another engine process, which holds this session's queue`,
    };
  }
  return null;
}

/**
 * Read the engine's own reachability fact once, for all three actions.
 *
 * The gate is resolved SEPARATELY from the action's own method, and
 * both are bound off the same host, so the engine is asked one question
 * ("who owns this turn") before it is asked a second one ("what is in
 * the queue"). A host that cannot answer the first cannot answer the
 * second correctly, and finding that out from a queue answer would be
 * a guess.
 *
 * @param {object} options
 * @param {string} options.sessionId The ENGINE session id.
 * @param {boolean} [options.read] Peek instead of boot.
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, host: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function requireReachableQueueHost(options) {
  const located = await requireQueueHost(options);
  if (!located.ok) return located;
  const { host } = located;
  const method = QUEUE_GATE_METHOD;
  if (typeof host.cliService?.[method] !== "function") {
    return {
      ok: false,
      code: "engine_member_unavailable",
      status: 501,
      error: `${ENDPOINT}: host.cliService.${method} is not a function`,
    };
  }
  let active;
  try {
    active = await host.cliService[method](options.sessionId);
  } catch (error) {
    return mapFollowUpError(error, `${ENDPOINT} (${method})`);
  }
  const unreachable = classifyQueueReachability(active);
  if (unreachable) {
    return { ok: false, code: unreachable.code, status: 409, error: unreachable.error };
  }
  return { ok: true, host };
}

/**
 * `GET /api/queue` — the panel's one read.
 *
 * The unreachable case is answered 200 with `reachable:false` rather
 * than 409, and the difference from the writes is deliberate: this
 * endpoint is polled, and a polled endpoint that raises an error every
 * few seconds teaches the user to ignore red. What it does instead is
 * say the queue is not in this process, in a field the client renders
 * as a sentence.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function readEngineQueue(options) {
  const endpoint = ENDPOINT;
  const reachable = await requireReachableQueueHost({
    sessionId: options.sessionId,
    read: true,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!reachable.ok) {
    if (reachable.code === QUEUE_TURN_NOT_HERE) {
      return {
        ok: true,
        payload: {
          ok: true,
          reachable: false,
          reason: QUEUE_TURN_NOT_HERE,
          items: [],
          paused: false,
          pendingCount: 0,
        },
      };
    }
    return reachable;
  }
  const bound = bindQueueMethod(reachable.host, "list");
  if (!bound.ok) return bound;
  let answer;
  try {
    answer = await bound.member({ id: options.sessionId });
  } catch (error) {
    return mapFollowUpError(error, `${endpoint} (listQueueMessages)`);
  }
  return {
    ok: true,
    payload: { ok: true, reachable: true, ...projectQueueList(answer) },
  };
}

/**
 * `POST /api/queue/reorder` — the panel's drag / arrow-key move.
 *
 * The engine requires the COMPLETE ordered id list, not a delta
 * (`reorderQueue` compares it against the ids it considers
 * user-manageable and rejects anything else). The client therefore
 * always sends every id it was shown, in the order it wants, and this
 * function's only job is to refuse a list that could not be a queue
 * before the engine sees it.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {unknown} options.itemIds
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function reorderEngineQueue(options) {
  const itemIds = normalizeQueueItemIds(options.itemIds);
  if (!itemIds) {
    return {
      ok: false,
      code: "invalid_queue_order",
      status: 400,
      error: `${ENDPOINT}: itemIds must be a list of unique, non-empty item ids covering the whole queue`,
    };
  }
  const reachable = await requireReachableQueueHost({
    sessionId: options.sessionId,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!reachable.ok) return reachable;
  const bound = bindQueueMethod(reachable.host, "reorder");
  if (!bound.ok) return bound;
  let answer;
  try {
    answer = await bound.member({ id: options.sessionId, itemIds });
  } catch (error) {
    return mapFollowUpError(error, `${ENDPOINT} (reorderQueue)`);
  }
  return { ok: true, payload: { ok: true, ...projectQueueList(answer) } };
}

/**
 * `POST /api/queue/cancel` — the panel's cancel control.
 *
 * The engine method is named `deleteQueueItem` and what it does is
 * `queue.cancel`, returning the item with `status: "cancelled"`. The
 * endpoint is named `cancel` because that is what the user asked for
 * and what the answer reports; renaming the engine call in prose would
 * make the code harder to trace back to the engine for no gain.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {unknown} options.itemId
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function cancelEngineQueueItem(options) {
  const itemId = normalizeQueueItemId(options.itemId);
  if (!itemId) {
    return {
      ok: false,
      code: "queue_item_required",
      status: 400,
      error: `${ENDPOINT}: itemId is required`,
    };
  }
  const reachable = await requireReachableQueueHost({
    sessionId: options.sessionId,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!reachable.ok) return reachable;
  const bound = bindQueueMethod(reachable.host, "cancel");
  if (!bound.ok) return bound;
  let answer;
  try {
    answer = await bound.member({ id: options.sessionId, itemId });
  } catch (error) {
    return mapFollowUpError(error, `${ENDPOINT} (deleteQueueItem)`);
  }
  const item = projectQueueItem(answer && answer.item);
  return { ok: true, payload: { ok: true, item } };
}

/**
 * Project one engine queue item onto the wire, dropping nothing that
 * identifies it and inventing nothing that is not there.
 *
 * `content` is passed through whole — the panel truncates for display,
 * and a server that shortened it would make the client unable to tell a
 * short message from a truncated one. `createdAt` and `status` are the
 * only two fields a position cannot be derived without.
 *
 * @param {unknown} item
 * @returns {object|null} `null` for anything without an item id, which
 *   the engine's own filter already rules out but an untrusted boundary
 *   should not assume.
 */
export function projectQueueItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = item.itemId;
  if (typeof id !== "string" || id.length === 0) return null;
  const out = { itemId: id };
  if (typeof item.sessionId === "string") out.sessionId = item.sessionId;
  if (typeof item.status === "string") out.status = item.status;
  if (typeof item.content === "string") out.content = item.content;
  if (typeof item.source === "string") out.source = item.source;
  if (typeof item.createdAt === "number") out.createdAt = item.createdAt;
  if (Array.isArray(item.attachments)) {
    out.attachmentCount = item.attachments.length;
  }
  return out;
}

/**
 * Project a whole list answer, keeping the three facts the panel needs:
 * the items in the engine's order, whether the queue is paused, and how
 * many items the engine counts as pending.
 *
 * `position` is NOT invented here. `listQueueMessages` returns items
 * already filtered to `status === "queued"` and already in queue order,
 * so the position of an item is its index — and the client computes it
 * from the array it was given rather than being told a number the server
 * then has to keep in step with.
 *
 * @param {unknown} answer
 * @returns {{items: object[], paused: boolean, pendingCount: number}}
 */
export function projectQueueList(answer) {
  const record = answer && typeof answer === "object" ? answer : {};
  const items = Array.isArray(record.items) ? record.items : [];
  return {
    items: items.map(projectQueueItem).filter(Boolean),
    paused: record.paused === true,
    pendingCount:
      typeof record.pendingCount === "number" && record.pendingCount >= 0
        ? record.pendingCount
        : items.length,
  };
}

/**
 * Normalise the reorder payload into the exact shape the engine wants.
 *
 * The engine is strict here and for a reason: `reorderQueue` compares
 * the submitted ids against the ids it considers user-manageable and
 * rejects anything that is not exactly that set (`QUEUE_REORDER_INVALID`).
 * Sending a partial list would therefore be an engine 400 with a message
 * written for the engine's own caller; refusing it here names the real
 * problem — the client sent a list the current queue does not match.
 *
 * @param {unknown} value
 * @returns {string[]|null} `null` means "not a usable id list".
 */
export function normalizeQueueItemIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length !== value.length) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

/**
 * Normalise the cancel payload's item id.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeQueueItemId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. `getQueueItem` and `updateQueueItem` are not exposed. Editing a
//    queued message's text is one more endpoint and one more control in
//    the panel, and the engine supports both; what is missing is the
//    decision about what "edit" means to a user who queued a message and
//    then changed their mind about three words of it. The panel shows
//    the full text, so a cancel-and-requeue is a complete substitute
//    today. Splitting it into a slice rather than half-landing it is the
//    honest call.
//
// 2. `paused` is passed through but not actionable. The engine reports
//    whether the queue is paused, and this family does not offer a
//    "resume" control, because the pause is set by something other than
//    a person at this panel (the turn system's own admission logic) and
//    inventing a resume button would imply a control the panel does not
//    actually own. The panel states the fact and changes nothing.
