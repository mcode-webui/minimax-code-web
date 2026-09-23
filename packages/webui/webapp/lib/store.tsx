"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import type { AuthorizeRequest, TokenFirstRun, WebuiState } from "./types";
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
}

const INITIAL: StoreSnapshot = {
  state: null,
  connected: false,
  error: null,
  authorize: null,
  firstRun: null,
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

  return () => {
    // Refcount-free teardown: the stream is intentionally long-lived, so a consumer
    // unmounting does not close it. Closing happens on page unload.
  };
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
