/**
 * Composer outbox — the in-flight send record.
 *
 * Shaped like the draft store in `composer-draft.ts`: a single module-scope
 * object, a `Set` of listeners, and a `subscribe`/`get` pair that
 * `useSyncExternalStore` consumes. The store survives the composer
 * remount that `page.tsx` triggers when the first user line arrives (a
 * `useState`-held record would die with the unmounted instance), so the
 * outbox is reachable both during a long in-flight window and after the
 * user navigates back into the composer.
 *
 * Why a separate store instead of extending `composer-draft.ts`: the
 * draft store is *what the user is typing right now*; the outbox is
 * *what was just sent*. Mixing them would re-introduce the very
 * vanishing-on-remount bug the draft store exists to prevent — a
 * remount mid-send that re-uses the same store would lose either the
 * draft or the record depending on which write landed last. Two
 * independent module-scope stores keep the two concerns apart.
 *
 * Per-cid / per-session scoping: each record carries the `cid` and
 * `sessionId` it was dispatched under. `failSend` only restores the
 * text into the composer when both still match — switching sessions
 * while a send is in flight MUST NOT paste another session's text into
 * the new session's composer.
 */

export type ComposerSentStatus = "in-flight" | "delivered" | "failed";

export interface ComposerSentRecord {
  /** Browser-stable client id (`lib/cid.ts`). The per-cid server keeps
   *  one engine subprocess; the outbox is keyed by it so two browsers
   *  on the same machine never share a record. */
  cid: string;
  /** Active session at dispatch time (`state.sessionId`, possibly
   *  null before the first snapshot). Session switches are caught by
   *  matching on this field — a failure in session A must not be
   *  restored into session B. */
  sessionId: string | null;
  /** Trimmed text the user submitted. Preserved verbatim for restore. */
  content: string;
  /** `@path` references captured at dispatch. Restored verbatim too. */
  attachments: string[];
  status: ComposerSentStatus;
  /** Failure message from the rejected request; `null` while in-flight
   *  or after a successful delivery. */
  error: string | null;
  /** `Date.now()` at the moment of the most recent state transition.
   *  Test-only determinism: the reducer accepts an injected timestamp
   *  so the same scenario is reproducible without a fake clock. */
  timestamp: number;
}

// --- Pure reducers --------------------------------------------------------
//
// All branching in the composer is concentrated here so the rest of the
// codebase (and the unit tests) can exercise the decision tree without a
// browser, a fetch, or a React tree. The composer's `submit` callback
// reads three transitions:
//   1. dispatch    — start a new send (status -> in-flight).
//   2. complete    — mark an in-flight record delivered.
//   3. fail        — mark an in-flight record failed and (when cid +
//                    sessionId still match) hand back the text the
//                    composer should restore.

/**
 * Dispatch a fresh send.
 *
 * Attachments are deep-copied so a later mutation of the caller's
 * array cannot leak into the record. The `timestamp` is overridable
 * for tests; the store wrapper injects `Date.now()`.
 */
export function dispatchSend(args: {
  cid: string;
  sessionId: string | null;
  content: string;
  attachments: string[];
  timestamp?: number;
}): ComposerSentRecord {
  return {
    cid: args.cid,
    sessionId: args.sessionId,
    content: args.content,
    attachments: [...args.attachments],
    status: "in-flight",
    error: null,
    timestamp: args.timestamp ?? Date.now(),
  };
}

/**
 * Mark a record delivered.
 *
 * Idempotent only on `in-flight`: a `delivered` write is a no-op
 * (already delivered), and a `failed` write is also a no-op so a
 * late-arriving success signal after a failure cannot silently
 * overwrite the failure banner. The composer calls this from the
 * success branch of its try/catch; the test suite pins the no-op
 * behaviour for the late-success case.
 */
export function completeSend(record: ComposerSentRecord): ComposerSentRecord {
  if (record.status !== "in-flight") return record;
  return { ...record, status: "delivered", error: null };
}

/** Restore payload returned by `failSend` when cid + sessionId match. */
export interface RestorePayload {
  content: string;
  attachments: string[];
}

/**
 * Mark an in-flight send failed and (when cid + sessionId match the
 * record's) return the text + attachments to put back into the composer.
 *
 * Returns `null` when the dispatch context no longer matches — the
 * user switched sessions, the cid rotated, etc. A `null` return means
 * the record is left untouched; the failure is logged nowhere on the
 * client because the wrong-session composer would have nothing to
 * show it on.
 *
 * `null` is also returned when there is no record at all (defensive:
 * the store wrapper already short-circuits, but the pure reducer has
 * to behave identically for direct callers).
 */
export function failSend(
  record: ComposerSentRecord | null,
  args: {
    cid: string;
    sessionId: string | null;
    error: string;
    timestamp?: number;
  },
): { record: ComposerSentRecord; payload: RestorePayload } | null {
  if (!record) return null;
  if (record.cid !== args.cid) return null;
  if (record.sessionId !== args.sessionId) return null;
  const next: ComposerSentRecord = {
    ...record,
    status: "failed",
    error: args.error,
    timestamp: args.timestamp ?? Date.now(),
  };
  return {
    record: next,
    payload: { content: record.content, attachments: [...record.attachments] },
  };
}

/** True iff the record's cid + sessionId match the active context. */
export function recordMatches(
  record: ComposerSentRecord | null,
  cid: string,
  sessionId: string | null,
): boolean {
  if (!record) return false;
  return record.cid === cid && record.sessionId === sessionId;
}

// --- Store -----------------------------------------------------------------
//
// One record, last write wins. Only one send is ever in flight per
// composer instance (the `sending` flag is the gate); a second submit
// while the first is unresolved overwrites the previous record, which
// is the right behaviour — the second message is the one the user is
// now committed to sending.

const listeners = new Set<() => void>();
let record: ComposerSentRecord | null = null;

export function startComposerSent(args: {
  cid: string;
  sessionId: string | null;
  content: string;
  attachments: string[];
}): ComposerSentRecord {
  record = dispatchSend(args);
  for (const listener of listeners) listener();
  return record;
}

export function completeComposerSent(): void {
  if (!record || record.status !== "in-flight") return;
  record = completeSend(record);
  for (const listener of listeners) listener();
}

/**
 * Mark the in-flight record failed. Returns the restore payload when
 * the dispatch context still matches; otherwise `null` and the record
 * is left as-is (the failure belongs to a session the user is no
 * longer looking at).
 */
export function failComposerSent(args: {
  cid: string;
  sessionId: string | null;
  error: string;
}): RestorePayload | null {
  const result = failSend(record, args);
  if (!result) return null;
  record = result.record;
  for (const listener of listeners) listener();
  return result.payload;
}

export function getComposerSent(): ComposerSentRecord | null {
  return record;
}

/** `useSyncExternalStore` subscription. Returns the unsubscribe thunk. */
export function subscribeComposerSent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear the store and its listeners between cases. */
export function resetComposerSentForTests(): void {
  record = null;
  listeners.clear();
}