// webapp/lib/follow-up-queue.ts
//
// PB-13 (`doc/placeholder-batch-plan.md` §5 row 5, G-1): the client
// half of the message queue.
//
// WHAT THE ENGINE ALREADY ANSWERS. `GET /api/queue` returns the engine's
// own list — the items, in the engine's order, with the ids, the status,
// the text and the attachment count. Nothing here reconstructs that.
// `listQueueMessages` is authoritative and the panel renders it.
//
// WHAT THIS MODULE ADDS, and why it is not a parallel queue:
//
//   1. `normalizeQueueSnapshot` — the untrusted-boundary reader. A
//      server answer is not a typed value until it has been read
//      field by field, and the browser talks to a server it shares a
//      version with only by accident.
//   2. `summarizeQueueContent` / `describeQueueStatus` — display
//      decisions (how much of a message fits on one line, what a status
//      word means), kept out of the component so they can be pinned by
//      a test without a renderer.
//   3. `moveQueueItemIds` — the reorder the panel computes before it
//      asks the server to make it real.
//   4. The local record store, and this is the part worth reading
//      twice. See "THE LOCAL RECORD STORE" below.
//
// THE LOCAL RECORD STORE IS NOT A QUEUE. When the composer queues a
// message, `POST /api/follow-up` answers with the engine's item id and
// position. Between that answer and the panel's next poll — seconds, in
// the common case, but a full poll interval if the panel is closed — the
// user has a message that the engine holds and the panel has not seen.
// This store is that gap, and nothing more:
//
//   - it is keyed by SESSION, because a queued message belongs to one
//     conversation and a queue leaked across sessions would be a lie
//     about another conversation's work;
//   - it lives in MODULE SCOPE, the way `lib/composer-sent.ts` does,
//     because the composer's React tree is replaced wholesale when a
//     session is created or cleared (`app/page.tsx` swaps the composer
//     between two positions) and an instance-scoped ref would freeze at
//     dispatch time;
//   - it is CLEARED the moment a server snapshot arrives, for the
//     sessions the snapshot covers.
//
// The engine list is the truth and the records are a transient
// placeholder for it. Where they could disagree, the server wins: every
// render derives from the snapshot when one has landed, and the records
// are only consulted for items the snapshot has not disproved.

import type { MessageKey } from "./i18n";

/** One queued message, as `GET /api/queue` reports it. */
export interface QueuedMessageItem {
  itemId: string;
  status: string;
  content: string;
  source?: string;
  createdAt?: number;
  attachmentCount?: number;
}

/**
 * The list answer.
 *
 * `reachable: false` is NOT an empty queue. It is the server saying the
 * engine does not hold this session's turn in this process, which is
 * the normal state under the default `acp` transport. The panel draws
 * a sentence for it; it does not draw an empty list, because "nothing
 * is queued" is a claim about the engine's queue and the server did not
 * make it.
 */
export interface QueueSnapshot {
  reachable: boolean;
  reason: string | null;
  items: QueuedMessageItem[];
  paused: boolean;
  pendingCount: number;
}

/** What a just-queued message is known to be, before the next poll. */
export interface QueuedFollowUpRecord {
  itemId: string;
  content: string;
  /** The position the engine reported, or null when it reported none. */
  position: number | null;
}

/** The reason code the server sends with `reachable: false`. */
export const QUEUE_REASON_TURN_NOT_HERE = "turn_not_here";

/**
 * How much of a queued message one row shows.
 *
 * A queued message is often a paragraph, and a panel that renders it
 * whole turns a three-item list into a wall. The full text stays
 * available: the row expands to the whole content on click, and the
 * cancel control never depends on seeing all of it.
 */
export const QUEUE_SUMMARY_MAX = 120;

/**
 * Read one engine item, field by field.
 *
 * `itemId` is the only field that can make an item unusable, so it is
 * the only one that can reject: a row with no id cannot be cancelled,
 * reordered or deduplicated, and rendering it would offer three
 * controls that cannot work. Everything else degrades to a neutral
 * value, because a missing content string is a display problem and a
 * missing id is a control problem.
 */
export function normalizeQueueItem(value: unknown): QueuedMessageItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const itemId = record.itemId;
  if (typeof itemId !== "string" || itemId.length === 0) return null;
  return {
    itemId,
    status: typeof record.status === "string" ? record.status : "queued",
    content: typeof record.content === "string" ? record.content : "",
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.createdAt === "number" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.attachmentCount === "number" && record.attachmentCount > 0
      ? { attachmentCount: record.attachmentCount }
      : {}),
  };
}

/**
 * Read a whole snapshot. Total: anything unrecognised becomes a
 * snapshot that says "not reachable", which is the state in which the
 * panel shows a sentence instead of a list. That is the safe default —
 * a malformed answer must never be rendered as "your queue is empty".
 */
export function normalizeQueueSnapshot(value: unknown): QueueSnapshot {
  const empty: QueueSnapshot = {
    reachable: false,
    reason: QUEUE_REASON_TURN_NOT_HERE,
    items: [],
    paused: false,
    pendingCount: 0,
  };
  if (!value || typeof value !== "object") return empty;
  const record = value as Record<string, unknown>;
  if (record.reachable !== true) {
    return {
      ...empty,
      reason: typeof record.reason === "string" ? record.reason : QUEUE_REASON_TURN_NOT_HERE,
    };
  }
  const items = Array.isArray(record.items)
    ? record.items.map(normalizeQueueItem).filter((item): item is QueuedMessageItem => item !== null)
    : [];
  return {
    reachable: true,
    reason: null,
    items,
    paused: record.paused === true,
    pendingCount:
      typeof record.pendingCount === "number" && record.pendingCount >= 0
        ? record.pendingCount
        : items.length,
  };
}

/**
 * One line of a queued message.
 *
 * Whitespace is collapsed FIRST, because a message pasted from a code
 * block or a terminal is mostly newlines, and a summary that measured
 * its own newlines would spend the whole budget on layout. The
 * ellipsis is added by the truncation, never by the collapse, so
 * `summarizeQueueContent` of an already-short message returns it
 * unchanged except for its spacing.
 */
export function summarizeQueueContent(content: string, max: number = QUEUE_SUMMARY_MAX): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * The i18n key for a queued item's status.
 *
 * The engine's status vocabulary is a string the client does not own,
 * so every branch is a named case and the fallback is a key that says
 * exactly that — "the engine reported a status this build does not
 * know" is a fact worth showing, and rendering the raw string in place
 * of a sentence would leak a protocol token into the UI.
 */
export function describeQueueStatus(status: string): MessageKey {
  switch (status) {
    case "queued":
      return "queue.status.queued";
    case "paused":
      return "queue.status.paused";
    case "cancelled":
      return "queue.status.cancelled";
    case "failed":
      return "queue.status.failed";
    default:
      return "queue.status.unknown";
  }
}

/**
 * Move one id within an ordered list, for the panel's up / down
 * controls.
 *
 * The engine's `reorderQueue` takes the COMPLETE ordered id list, not a
 * delta, so the panel's only job is to produce that list — and to
 * refuse honestly when the item is already at the end, rather than
 * sending a no-op and rendering a spinner for a move that did not
 * happen. `null` means "no move": the control should be disabled, and
 * the test pins that the input was not mutated.
 *
 * @param ids The current order, engine order.
 * @param itemId The item to move.
 * @param delta `-1` moves toward the front, `+1` toward the back.
 * @returns The new order, or `null` when the move is out of range or
 *   the item is not in the list.
 */
export function moveQueueItemIds(
  ids: readonly string[],
  itemId: string,
  delta: -1 | 1,
): string[] | null {
  const from = ids.indexOf(itemId);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, itemId);
  return next;
}

// --- the local record store -------------------------------------------------

/**
 * Queued messages this tab sent, per session, awaiting the first poll.
 *
 * Keyed by the WEBUI session id — the id the composer knows — and never
 * by an engine id, because the composer only ever knows the webui one.
 * Cleared per session; nothing reads across sessions.
 */
const localRecords = new Map<string, Map<string, QueuedFollowUpRecord>>();

/**
 * Remember a message the engine has just accepted.
 *
 * Called with the `POST /api/follow-up` answer, so both values are the
 * ENGINE's (SB-4 projects `itemId` / `position` straight out of
 * `enqueueMessage`'s return). A record with no item id is not
 * remembered: the server returns `itemId: null` when the engine did not
 * report one, and a record with a null id could not be cancelled or
 * reordered even if the panel invented one.
 *
 * @param sessionId The webui session id.
 * @param record What the engine answered.
 */
export function recordQueuedFollowUp(
  sessionId: string,
  record: { itemId?: string | null; position?: number | null; content: string },
): void {
  if (!sessionId || typeof record.itemId !== "string" || record.itemId.length === 0) return;
  const existing = localRecords.get(sessionId) ?? new Map<string, QueuedFollowUpRecord>();
  // Re-queueing after a cancel, or a retry that landed twice, must not
  // grow the map: the engine dedupes on `clientRequestId`, so the second
  // answer describes the SAME item.
  existing.set(record.itemId, {
    itemId: record.itemId,
    content: record.content,
    position: typeof record.position === "number" ? record.position : null,
  });
  localRecords.set(sessionId, existing);
}

/**
 * The records for one session, in the order they were queued.
 *
 * Insertion order is the order the user pressed send, which is the
 * order the engine put them in too; nothing re-sorts this, because it
 * is a placeholder for a list the server is about to send and sorting
 * it here would be a second ordering rule to keep in step.
 */
export function readQueuedFollowUps(sessionId: string): QueuedFollowUpRecord[] {
  const existing = localRecords.get(sessionId);
  if (!existing) return [];
  return [...existing.values()];
}

/**
 * Drop one session's records.
 *
 * Called when a server snapshot lands: from that moment the snapshot is
 * the list, and a record the snapshot does not contain is either gone
 * (the dispatcher ran it) or never existed (the engine rejected it and
 * the composer said so). Keeping it would resurrect a row the engine
 * has already answered about.
 */
export function clearQueuedFollowUps(sessionId: string): void {
  localRecords.delete(sessionId);
}

/**
 * The records, filtered to the ids the snapshot does NOT already carry.
 *
 * This is the one place the two sources meet, and the rule is short:
 * the server wins, always. A record only survives while the server has
 * not spoken about it, so the panel can show a message the moment it is
 * queued without ever contradicting a list that has arrived.
 */
export function pendingLocalRecords(
  sessionId: string,
  snapshot: QueueSnapshot,
): QueuedFollowUpRecord[] {
  if (!snapshot.reachable) return readQueuedFollowUps(sessionId);
  const known = new Set(snapshot.items.map((item) => item.itemId));
  return readQueuedFollowUps(sessionId).filter((record) => !known.has(record.itemId));
}
