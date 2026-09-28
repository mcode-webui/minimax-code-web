"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import type { AuthorizeRequest, TokenFirstRun, WebuiState } from "./types";
import * as api from "./api";
import { withClientQuery } from "./cid";
import { NAMED_EVENTS, parseSseFrame, type SseAction } from "./sse";

/**
 * Session store — one shared subscription to the server's state stream.
 *
 * The server owns the state and pushes a full snapshot over SSE (`GET /api/events`,
 * an unnamed `message` event carrying the whole object, throttled and diffed
 * server-side). The client therefore never merges updates: it replaces the
 * snapshot and re-renders from it.
 *
 * The store lives at module scope rather than in a React state container so
 * that the SSE connection survives navigation and is shared by every component
 * that reads it.
 *
 * The snapshot is written on the Next.js static export, so `getServerSnapshot`
 * must return a stable object: a fresh one on every call would loop forever.
 */

export interface StoreSnapshot {
  state: WebuiState | null;
  connected: boolean;
  error: string | null;
  /** A tool-approval / plan-review request awaiting an answer. */
  authorize: AuthorizeRequest | null;
  /** Present once, on the very first server start, until acknowledged. */
  firstRun: TokenFirstRun | null;
  /**
   * Plan quota (5-hour and weekly windows), kept fresh by `startQuotaPolling`
   * rather than by the SSE snapshot: the snapshot is broadcast to every
   * subscriber, including over the LAN, so account data does not belong in it.
   */
  quota: api.QuotaSnapshot | null;
  quotaBusy: boolean;
  quotaError: string | null;
  /**
   * Monotonic counter that bumps every time a `providers.updated` SSE frame
   * arrives. Consumers (the management panel, the model selector) listen to
   * the counter rather than to the payload itself: re-fetching through the
   * typed API client keeps masking + auth + headers consistent across the
   * app, and a counter is enough to trigger an effect. The counter resets
   * to 0 on mount; the absolute value is meaningless across reloads.
   */
  providersRevision: number;
  /**
   * Ticket 08 (set-model SSE race) — the highest per-cid snapshot
   * revision the store has applied so far. Each full-state frame
   * carries a server-stamped `revision`; the store only replaces the
   * live `state` when the incoming revision strictly exceeds the
   * stored value. This makes the rendered UI monotonic regardless of
   * any wire-reordering / coalesce-window late-arrivals and is the
   * client-side companion to the server-side ownership-aware mirror
   * in `applyConfigOptionUpdate` (server/lib/mcode-acp.js). `-1`
   * means "no snapshot has been accepted yet" — the first frame
   * always passes the guard.
   */
  stateRevision: number;
  /**
   * Slice 06 — Agent Team. Bumped every time the server emits a
   * `session-tree-changed` SSE frame. Consumers (the sidebar session
   * tree, the agent-team panel) listen for the bump and re-fetch
   * `GET /api/session-tree` to pick up newly-spawned subagent rows.
   * Same shape as `providersRevision`: a counter is enough to trigger
   * an effect; re-fetching through the typed API client keeps the
   * response handling consistent across the app.
   */
  treeRevision: number;
}

const INITIAL: StoreSnapshot = {
  state: null,
  connected: false,
  error: null,
  authorize: null,
  firstRun: null,
  quota: null,
  quotaBusy: false,
  quotaError: null,
  providersRevision: 0,
  stateRevision: -1,
  treeRevision: 0,
};

let snapshot: StoreSnapshot = INITIAL;
const listeners = new Set<() => void>();

function setSnapshot(patch: Partial<StoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

/**
 * Test-only handle: read the live snapshot. The production module never
 * exposes this; the test runner (webapp/test/store-revision.test.ts)
 * asserts through it after dispatching frames into the EventSource.
 */
export function __testSnapshot(): StoreSnapshot {
  return snapshot;
}

/**
 * Active session id from the module-scope snapshot.
 *
 * Why a separate accessor instead of reading from a React component's
 * closure: the SSE-driven store lives at module scope (it must — the
 * SSE connection has to outlive every component). A composer's
 * in-flight submit can be closed over a ref that was current at
 * dispatch time; if the user switches sessions, that ref is frozen
 * at the OLD session id because the component may have remounted
 * (page.tsx swaps the composer between the inline and chat-tree
 * positions when `hasConversation` flips). Reading from this
 * accessor at catch time resolves the live session id from the
 * SAME module-scope state the SSE handler writes — it survives
 * remounts and is updated by every state push.
 *
 * The composer's `submit` reads this at catch time so the cid +
 * sessionId restore-gate compares against the active context, not
 * a stale closure snapshot.
 */
export function getActiveSessionId(): string | null {
  return snapshot.state ? snapshot.state.sessionId : null;
}

/**
 * Test-only handle: simulate an SSE frame dispatch. Production code
 * NEVER calls this — it exists so the revision-guard reducer can be
 * unit-tested without standing up React.
 *
 * @param action the parsed SSE action to apply
 * @returns the resulting snapshot
 */
export function __testApplyAction(action: SseAction | { kind: "connected"; value: boolean }): StoreSnapshot {
  switch (action.kind) {
    case "state": {
      const incoming = action.state.revision;
      if (typeof incoming === "number") {
        if (incoming <= snapshot.stateRevision) return snapshot;
        setSnapshot({
          state: action.state,
          stateRevision: incoming,
          connected: true,
          error: null,
        });
      } else {
        setSnapshot({ state: action.state, connected: true, error: null });
      }
      return snapshot;
    }
    case "authorize":
      setSnapshot({ authorize: action.request });
      return snapshot;
    case "authorize-cleared":
      setSnapshot({ authorize: null });
      return snapshot;
    case "first-run":
      setSnapshot({ firstRun: action.payload });
      return snapshot;
    case "providers-updated":
      setSnapshot({ providersRevision: snapshot.providersRevision + 1 });
      return snapshot;
    case "tree-changed":
      // Slice 06: bump the revision so the sidebar session tree refetches.
      // The masked payload carried by the SSE frame is NOT stored — the
      // consumers re-read through the typed API client.
      setSnapshot({ treeRevision: snapshot.treeRevision + 1 });
      return snapshot;
    case "malformed":
      setSnapshot({ error: `malformed ${action.event || "message"} frame` });
      return snapshot;
    case "heartbeat":
    case "ignored":
      return snapshot;
    case "connected":
      setSnapshot({ connected: action.value });
      return snapshot;
  }
  return snapshot;
}

/**
 * Test-only handle: reset the store to its INITIAL state between
 * tests. Production code never calls this.
 */
export function __testReset(): void {
  snapshot = INITIAL;
  listeners.clear();
  source = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): StoreSnapshot => snapshot;
/** Static-export prerender: no live stream, so the constant initial snapshot. */
const getServerSnapshot = (): StoreSnapshot => INITIAL;

/** The SSE endpoint takes the token and client id as query parameters. */
function eventsUrl(): string {
  return withClientQuery("/api/events");
}

let source: EventSource | null = null;

/** Open the state stream. Idempotent; safe to call from every consumer's effect. */
export function connect(): () => void {
  if (typeof window === "undefined") return () => {};

  if (!source) {
    const eventSource = new EventSource(eventsUrl());
    source = eventSource;

    eventSource.onopen = () => setSnapshot({ connected: true, error: null });

    // One dispatcher for every frame: the classification lives in lib/sse.ts so the
    // event contract is testable independently of this component.
    const handle = (event: string, data: string) => {
      const action = parseSseFrame(event, data);
      switch (action.kind) {
        case "state": {
          // Ticket 08 (set-model SSE race): revision guard. The server
          // stamps every snapshot with a per-cid monotonic `revision`.
          // Apply the snapshot ONLY when the incoming revision strictly
          // exceeds the last-applied one — a wire-reordered or
          // coalesce-window-late frame cannot rewind the rendered state.
          // The initial value is `-1`, so the very first snapshot always
          // passes the guard.
          const incoming = action.state.revision;
          if (typeof incoming === "number") {
            if (incoming <= snapshot.stateRevision) break;
            setSnapshot({
              state: action.state,
              stateRevision: incoming,
              connected: true,
              error: null,
            });
          } else {
            // No revision on the frame (defensive — every server-side
            // writer stamps one). Accept the snapshot so the UI keeps
            // moving, but DO NOT advance the guard so a subsequent
            // lower-revision frame is still rejected. Future tags
            // without the field are caught by this branch as well.
            setSnapshot({ state: action.state, connected: true, error: null });
          }
          break;
        }
        case "authorize":
          setSnapshot({ authorize: action.request });
          break;
        case "authorize-cleared":
          setSnapshot({ authorize: null });
          break;
        case "first-run":
          setSnapshot({ firstRun: action.payload });
          break;
        case "providers-updated":
          // Bump the revision so the management panel and the model
          // selector re-fetch. The masked payload carried by the SSE
          // frame is NOT stored — the consumers read the typed API
          // again, which keeps the masking and auth headers consistent
          // across the app (and lets us drop a frame-shaped buffer).
          setSnapshot({ providersRevision: snapshot.providersRevision + 1 });
          break;
        case "tree-changed":
          // Slice 06: bump the revision so the sidebar session tree
          // re-fetches. The server fires this on every subagent row
          // insertion (applyToolUpdate → recordSubagentForCid).
          setSnapshot({ treeRevision: snapshot.treeRevision + 1 });
          break;
        case "malformed":
          setSnapshot({ error: `malformed ${action.event || "message"} frame` });
          break;
        case "heartbeat":
        case "ignored":
          break;
      }
    };

    // Unnamed events carry the full state snapshot.
    eventSource.onmessage = (event: MessageEvent<string>) => handle("", event.data);

    for (const name of NAMED_EVENTS) {
      eventSource.addEventListener(name, (event) => {
        handle(name, (event as MessageEvent<string>).data);
      });
    }

    eventSource.onerror = () => {
      // EventSource reconnects on its own; report the gap without tearing it down.
      setSnapshot({ connected: false, error: "stream disconnected" });
    };
  }

  // Polling rides on the same long-lived lifetime as the stream.
  startQuotaPolling();

  return () => {
    // Refcount-free teardown: the stream is intentionally long-lived, so a consumer
    // unmounting does not close it. Closing happens on page unload.
  };
}

/**
 * Read the quota and put it in the store.
 *
 * `record` is passed through to the server (see `api.getQuota`): the poll leaves
 * it off, so only a deliberate refresh adds a forecast sample.
 */
export async function refreshQuota(record = false): Promise<void> {
  setSnapshot({ quotaBusy: true });
  try {
    const next = await api.getQuota(record);
    setSnapshot({ quota: next, quotaError: null });
  } catch (cause) {
    setSnapshot({
      quotaError: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    setSnapshot({ quotaBusy: false });
  }
}

// Two minutes. The 5-hour window moves slowly, and this is a POST that asks the
// engine, so there is nothing to gain from asking more often.
const QUOTA_POLL_MS = 120_000;
let quotaTimer: number | null = null;

/**
 * Poll the quota for as long as the page is open, so the popover has a figure
 * before it is ever hovered instead of only after a manual refresh.
 *
 * Idempotent, like `connect()`: it is called from the same effect. A hidden tab
 * does not poll — nobody is reading the number — and catches up on the way back
 * via `visibilitychange`.
 */
export function startQuotaPolling(): void {
  if (typeof window === "undefined" || quotaTimer !== null) return;
  const tick = () => {
    if (document.hidden) return;
    void refreshQuota();
  };
  void refreshQuota();
  quotaTimer = window.setInterval(tick, QUOTA_POLL_MS);
  document.addEventListener("visibilitychange", tick);
}

export function dismissFirstRun(): void {
  setSnapshot({ firstRun: null });
}

/** Read the live server state. */
export function useSession(): StoreSnapshot {
  useEffect(connect, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const SessionContext = createContext<StoreSnapshot | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const value = useSession();
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Read the session from context; throws outside the provider so misuse is loud. */
export function useSessionContext(): StoreSnapshot {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSessionContext requires <SessionProvider>");
  return value;
}

/**
 * Re-render on an interval, returning the current timestamp.
 *
 * Used by the elapsed-time readouts (thinking duration, run timer), which are
 * derived from timestamps in the snapshot rather than pushed by the server — the
 * snapshot only changes when something happens, so a clock needs its own tick.
 */
export function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
