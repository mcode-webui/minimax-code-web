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
import { NAMED_EVENTS, parseSseFrame } from "./sse";

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
};

let snapshot: StoreSnapshot = INITIAL;
const listeners = new Set<() => void>();

function setSnapshot(patch: Partial<StoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
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
        case "state":
          setSnapshot({ state: action.state, connected: true, error: null });
          break;
        case "authorize":
          setSnapshot({ authorize: action.request });
          break;
        case "authorize-cleared":
          setSnapshot({ authorize: null });
          break;
        case "first-run":
          setSnapshot({ firstRun: action.payload });
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
