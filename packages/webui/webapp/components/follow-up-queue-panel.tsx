// FollowUpQueuePanel — PB-13 (`doc/placeholder-batch-plan.md` §5 row 5,
// G-1): the visible face of the engine's message queue.
//
// SB-4 wired the composer's 跟进消息行为 switch to `enqueueMessage` and
// left a queued message with an item id and a position that nothing
// displayed, which its KNOWN DEBT 2 named as the next slice's scope. This
// is that slice: the list, the position, the status, and the two actions
// the engine can actually perform on a queued message today — reorder and
// cancel.
//
// WHAT IS REAL AND WHAT IS NOT, because the panel is where that
// difference becomes visible:
//
//   - The LIST, the ORDER and the STATUS are the engine's. They come
//     from `GET /api/queue`, which reaches `cliService.listQueueMessages`
//     on every poll. Nothing here reconstructs, re-sorts or merges a
//     list the server did not send.
//   - REORDER is the engine's `reorderQueue`, and CANCEL is the engine's
//     `deleteQueueItem` (which is `queue.cancel`). Both are the engine
//     deciding; this component only sends the intent and renders the
//     answer.
//   - WHEN THE ENGINE DOES NOT HOLD THE TURN — the normal state under
//     the default `acp` transport, where the running turn lives in an
//     `mcode acp` subprocess — the server answers `reachable: false`
//     and this panel says so in words. It does not draw an empty list,
//     because "nothing is queued" is a claim about the engine's queue
//     that the server did not make.
//
// WHY THE POLL EXISTS RATHER THAN A STREAM. The engine publishes
// `session.queue.updated` on its own event bus
// (`local-runtime-v2/src/application/queue/queue-application.ts`
// `QueueCommittedEventProjector`), but webui's SSE channel carries the
// webui turn stream, not the engine's global bus, so there is nothing
// to subscribe to without opening a second stream whose only payload
// would be "something changed, look again". A four-second poll on an
// EXPANDED panel is the cheaper and more honest version of that: it
// runs only while a person is looking at the list, and a collapsed
// panel costs nothing.

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import {
  clearQueuedFollowUps,
  describeQueueStatus,
  moveQueueItemIds,
  normalizeQueueSnapshot,
  pendingLocalRecords,
  summarizeQueueContent,
} from "../lib/follow-up-queue";
import type { QueuedMessageItem, QueueSnapshot } from "../lib/follow-up-queue";

/**
 * How often an EXPANDED panel asks the engine for the list.
 *
 * Four seconds is a product decision, not a measured one: it is short
 * enough that a cancel looks immediate and long enough that a person
 * reading the list is not generating a request per second. It is paid
 * only while expanded, so the common case — a collapsed chip in the
 * composer — costs zero.
 */
export const QUEUE_POLL_INTERVAL_MS = 4000;

export interface FollowUpQueuePanelProps {
  /** The WEBUI session id — the same one the composer sends. */
  sessionId: string | null;
  /**
   * Whether a turn is running. The queue is the queue OF a turn, so
   * with no turn there is nothing to show and the panel stays hidden —
   * a permanently visible empty panel during every conversation is
   * noise.
   */
  running: boolean;
  /**
   * Bumped by the composer after a successful queue, so the panel
   * refetches without waiting out its poll interval. It is a token
   * rather than a callback because the panel already owns the request
   * and the composer owns the trigger; a callback would only move the
   * same call one level up.
   */
  refreshToken: number;
  t: (key: MessageKey) => string;
}

interface PanelState {
  snapshot: QueueSnapshot | null;
  loading: boolean;
  error: string | null;
  /** The item currently being moved or cancelled, for per-row state. */
  busyItemId: string | null;
}

export function FollowUpQueuePanel(props: FollowUpQueuePanelProps): React.JSX.Element | null {
  const { sessionId, running, refreshToken, t } = props;
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<PanelState>({
    snapshot: null,
    loading: false,
    error: null,
    busyItemId: null,
  });
  // A ref, not state: the poll callback must see the newest session id
  // without the interval restarting on every switch, and a closure over
  // a stale session id would list the PREVIOUS conversation's queue.
  const sessionRef = useRef<string | null>(sessionId);
  sessionRef.current = sessionId;

  const refresh = useCallback(async () => {
    const target = sessionRef.current;
    if (!target) {
      setState({ snapshot: null, loading: false, error: null, busyItemId: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const answer = await api.listQueue();
      // A list that has landed supersedes every local record for this
      // session: from here the server is the list, and a record it does
      // not mention is either already run or never existed.
      clearQueuedFollowUps(target);
      setState({
        snapshot: normalizeQueueSnapshot(answer),
        loading: false,
        error: null,
        busyItemId: null,
      });
    } catch (cause) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }, []);

  // The composer bumped the token: the user just queued something, so
  // the list is stale by definition and waiting four seconds to show
  // the message they just sent would read as a dropped send.
  useEffect(() => {
    if (!running || !sessionId || refreshToken === 0) return;
    void refresh();
  }, [refreshToken, running, sessionId, refresh]);

  // Session switch: a queue belongs to one conversation. Keeping the
  // previous session's list on screen while the new one loads would be
  // a claim about work the user is no longer looking at.
  useEffect(() => {
    setState({ snapshot: null, loading: false, error: null, busyItemId: null });
  }, [sessionId]);

  useEffect(() => {
    if (!expanded || !running || !sessionId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), QUEUE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [expanded, running, sessionId, refresh]);

  const move = useCallback(
    async (itemId: string, delta: -1 | 1) => {
      const snapshot = state.snapshot;
      if (!snapshot?.reachable) return;
      const next = moveQueueItemIds(
        snapshot.items.map((item) => item.itemId),
        itemId,
        delta,
      );
      // `null` means the item is already at the end of that direction.
      // The control is disabled in that case; refusing here as well is
      // what keeps a keyboard or a stale click from sending a no-op.
      if (!next) return;
      setState((prev) => ({ ...prev, busyItemId: itemId, error: null }));
      try {
        const answer = await api.reorderQueue(next);
        setState((prev) => ({
          ...prev,
          // The engine's new order, never the one requested.
          snapshot: normalizeQueueSnapshot({
            reachable: true,
            items: answer.items,
            pendingCount: prev.snapshot?.pendingCount ?? next.length,
            paused: prev.snapshot?.paused ?? false,
          }),
          loading: false,
          error: null,
          busyItemId: null,
        }));
      } catch (cause) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
          busyItemId: null,
        }));
      }
    },
    [state.snapshot],
  );

  const cancel = useCallback(async (itemId: string) => {
    setState((prev) => ({ ...prev, busyItemId: itemId, error: null }));
    try {
      await api.cancelQueueItem(itemId);
      await refresh();
    } catch (cause) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
        busyItemId: null,
      }));
    }
  }, [refresh]);

  if (!running || !sessionId) return null;

  const snapshot = state.snapshot;
  const locals = pendingLocalRecords(sessionId, snapshot ?? { reachable: false, reason: null, items: [], paused: false, pendingCount: 0 });
  const itemCount = (snapshot?.reachable ? snapshot.items.length : 0) + locals.length;

  return (
    <div
      className="mx-3 mb-2 rounded-xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated"
      data-testid="follow-up-queue-panel"
      data-queue-state={snapshot ? (snapshot.reachable ? "reachable" : "unreachable") : "unknown"}
      data-queue-count={itemCount}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        data-testid="follow-up-queue-toggle"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-caption-small-strong text-text_default_secondary hover:bg-bg_interaction_secondary_hover"
      >
        <span>{t("queue.title")}</span>
        <span data-testid="follow-up-queue-count">{itemCount}</span>
        {snapshot?.paused ? (
          <span className="text-text_status_warning">{t("queue.paused")}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="border-t-[0.5px] border-border_default px-3 py-2" data-testid="follow-up-queue-body">
          {state.error ? (
            <p
              className="pb-2 text-caption-small-strong text-text_status_error"
              data-testid="follow-up-queue-error"
            >
              {t("queue.failed")}: {state.error}
            </p>
          ) : null}

          {snapshot && !snapshot.reachable ? (
            /* THE HONEST BOUNDARY. The engine is not running this
               session's turn in this process, so its queue is not
               readable from here. Saying "empty" would be a claim the
               server did not make; saying this says what is true. */
            <p
              className="pb-2 text-caption-small text-text_default_secondary"
              data-testid="follow-up-queue-unreachable"
            >
              {t("queue.unreachable")}
            </p>
          ) : null}

          {snapshot?.reachable && snapshot.items.length === 0 ? (
            <p
              className="pb-2 text-caption-small text-text_default_secondary"
              data-testid="follow-up-queue-empty"
            >
              {state.loading ? t("queue.loading") : t("queue.empty")}
            </p>
          ) : null}

          <ol className="flex flex-col gap-1" data-testid="follow-up-queue-list">
            {snapshot?.reachable
              ? snapshot.items.map((item, index) => (
                  <QueueRow
                    key={item.itemId}
                    item={item}
                    position={index}
                    first={index === 0}
                    last={index === snapshot.items.length - 1}
                    busy={state.busyItemId === item.itemId}
                    t={t}
                    onMove={move}
                    onCancel={cancel}
                  />
                ))
              : null}
            {locals.map((record) => (
              <li
                key={record.itemId}
                data-testid="follow-up-queue-local"
                data-queue-pending="true"
                className="flex flex-col gap-1 rounded-lg px-1 py-1"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-caption-small-strong text-text_default_tertiary">
                    {t("queue.awaiting")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-caption-small text-text_default_primary">
                    {summarizeQueueContent(record.content)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void cancel(record.itemId)}
                    data-testid={`follow-up-queue-local-cancel-${record.itemId}`}
                    aria-label={t("queue.cancel")}
                    className="shrink-0 rounded px-1 text-caption-small text-text_default_tertiary hover:bg-bg_interaction_secondary_hover"
                  >
                    {t("queue.cancel")}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function QueueRow(props: {
  item: QueuedMessageItem;
  position: number;
  first: boolean;
  last: boolean;
  busy: boolean;
  t: (key: MessageKey) => string;
  onMove: (itemId: string, delta: -1 | 1) => void;
  onCancel: (itemId: string) => void;
}): React.JSX.Element {
  const { item, position, first, last, busy, t, onMove, onCancel } = props;
  return (
    <li
      data-testid={`follow-up-queue-item-${item.itemId}`}
      data-queue-status={item.status}
      className="flex flex-col gap-1 rounded-lg px-1 py-1"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-caption-small-strong text-text_default_tertiary">
          {t("queue.position").replace("{n}", String(position + 1))}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-caption-small text-text_default_primary"
          title={item.content}
        >
          {summarizeQueueContent(item.content)}
        </span>
        <span className="shrink-0 text-caption-small text-text_default_tertiary">
          {t(describeQueueStatus(item.status))}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {item.attachmentCount ? (
          <span className="text-caption-small text-text_default_tertiary">
            {t("queue.attachments").replace("{n}", String(item.attachmentCount))}
          </span>
        ) : null}
        <button
          type="button"
          disabled={busy || first}
          onClick={() => onMove(item.itemId, -1)}
          data-testid={`follow-up-queue-up-${item.itemId}`}
          aria-label={t("queue.moveUp")}
          className="rounded px-1 text-caption-small text-text_default_tertiary hover:bg-bg_interaction_secondary_hover disabled:opacity-40"
        >
          {t("queue.moveUp")}
        </button>
        <button
          type="button"
          disabled={busy || last}
          onClick={() => onMove(item.itemId, 1)}
          data-testid={`follow-up-queue-down-${item.itemId}`}
          aria-label={t("queue.moveDown")}
          className="rounded px-1 text-caption-small text-text_default_tertiary hover:bg-bg_interaction_secondary_hover disabled:opacity-40"
        >
          {t("queue.moveDown")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onCancel(item.itemId)}
          data-testid={`follow-up-queue-cancel-${item.itemId}`}
          aria-label={t("queue.cancel")}
          className="rounded px-1 text-caption-small text-text_default_tertiary hover:bg-bg_interaction_secondary_hover disabled:opacity-40"
        >
          {t("queue.cancel")}
        </button>
      </div>
    </li>
  );
}
