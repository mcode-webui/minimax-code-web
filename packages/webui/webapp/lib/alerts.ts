"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { AlertItem } from "./api";
import { withClientQuery } from "./cid";

/**
 * Alerts channel — one shared subscription to the server's anomaly stream.
 *
 * `GET /api/alerts` is a **Server-Sent Events** endpoint (see
 * server/routes/alerts.js): it writes a snapshot frame, then one frame per
 * `pushAlert()` and a heartbeat every 30s, and the response never ends. It is
 * therefore only readable through an `EventSource`.
 *
 * The store lives at module scope, like lib/store.tsx, so the badge count in the
 * sidebar and the alerts/progress panels share a single connection instead of
 * opening one each.
 */

export type AlertFrame =
  /** The ring buffer as it stood when the stream opened (oldest → newest). */
  | { kind: "snapshot"; alerts: AlertItem[] }
  /** A new alert was pushed. */
  | { kind: "append"; alert: AlertItem }
  /** An existing alert was deduplicated into: its `count`/`ts` moved. */
  | { kind: "update"; alert: AlertItem }
  /** Keepalive; nothing to render. */
  | { kind: "heartbeat" }
  /** A frame we could not parse. Surfaced so callers can stay quiet but auditable. */
  | { kind: "malformed"; detail: string };

/** Ring-buffer cap, mirrored from the server so a long-lived tab cannot grow without bound. */
const MAX_ALERTS = 200;

/**
 * Classify one frame from `GET /api/alerts`.
 *
 * A frame with no `event:` name is the JSON payload; the only named frame the
 * server sends is `heartbeat`, whose data is `{"ts":…}`. Unknown names are
 * ignored rather than treated as errors, matching the state stream's
 * forward-compatibility rule (see lib/sse.ts).
 */
export function parseAlertFrame(event: string, data: string): AlertFrame {
  if (event && event !== "message") {
    return event === "heartbeat"
      ? { kind: "heartbeat" }
      : { kind: "malformed", detail: `unknown event: ${event}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    return { kind: "malformed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "malformed", detail: "frame is not an object" };
  }
  const frame = parsed as { kind?: unknown; alerts?: unknown; alert?: unknown };
  switch (frame.kind) {
    case "snapshot":
      return {
        kind: "snapshot",
        alerts: Array.isArray(frame.alerts) ? (frame.alerts as AlertItem[]) : [],
      };
    case "append":
    case "update":
      if (!frame.alert || typeof frame.alert !== "object") {
        return { kind: "malformed", detail: `${String(frame.kind)} without an alert` };
      }
      return { kind: frame.kind, alert: frame.alert as AlertItem };
    default:
      return { kind: "malformed", detail: `unknown frame kind: ${String(frame.kind)}` };
  }
}

/**
 * Fold one frame into the alert list.
 *
 * `append` prepends (the list is newest-first for display), `update` replaces
 * in place so a deduplicated alert's bumped `count` reaches the UI without
 * reordering. Frames are capped at the server's ring size.
 */
export function applyAlertFrame(current: AlertItem[], frame: AlertFrame): AlertItem[] {
  switch (frame.kind) {
    case "snapshot":
      return frame.alerts.slice().reverse().slice(0, MAX_ALERTS);
    case "append": {
      const next = [frame.alert, ...current.filter((item) => item.id !== frame.alert.id)];
      return next.slice(0, MAX_ALERTS);
    }
    case "update": {
      const index = current.findIndex((item) => item.id === frame.alert.id);
      if (index < 0) return [frame.alert, ...current].slice(0, MAX_ALERTS);
      const next = current.slice();
      next[index] = frame.alert;
      return next;
    }
    case "heartbeat":
    case "malformed":
      return current;
  }
}

interface AlertSnapshot {
  alerts: AlertItem[];
  connected: boolean;
}

let snapshot: AlertSnapshot = { alerts: [], connected: false };
const listeners = new Set<() => void>();

function setAlerts(alerts: AlertItem[]): void {
  snapshot = { ...snapshot, alerts };
  for (const listener of listeners) listener();
}

function setConnected(connected: boolean): void {
  if (snapshot.connected === connected) return;
  snapshot = { ...snapshot, connected };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): AlertSnapshot => snapshot;
/** Static-export prerender: no live stream, so the constant empty snapshot. */
const getServerSnapshot = (): AlertSnapshot => EMPTY_SNAPSHOT;
const EMPTY_SNAPSHOT: AlertSnapshot = { alerts: [], connected: false };

let source: EventSource | null = null;

/**
 * Open the alerts stream. Idempotent — the first caller opens the one
 * connection, later callers attach to the same subscription.
 */
export function connectAlerts(): () => void {
  if (typeof window === "undefined") return () => {};

  if (!source) {
    const eventSource = new EventSource(withClientQuery("/api/alerts"));
    source = eventSource;

    eventSource.onopen = () => setConnected(true);

    const handle = (event: string, data: string) => {
      const frame = parseAlertFrame(event, data);
      if (frame.kind === "heartbeat") {
        setConnected(true);
        return;
      }
      // A malformed frame is dropped rather than surfaced: the channel is
      // diagnostic by nature, and a single bad frame must not blank the badge
      // or throw into render.
      if (frame.kind === "malformed") return;
      setAlerts(applyAlertFrame(snapshot.alerts, frame));
    };

    eventSource.onmessage = (event: MessageEvent<string>) => handle("", event.data);
    eventSource.addEventListener("heartbeat", (event) => {
      handle("heartbeat", (event as MessageEvent<string>).data);
    });

    eventSource.onerror = () => {
      // EventSource reconnects on its own; report the gap without tearing it down.
      setConnected(false);
    };
  }

  return () => {
    // Refcount-free teardown, like the state stream: the connection is
    // long-lived so a consumer unmounting does not close it. Closing happens on
    // page unload.
  };
}

/** Read the alert ring buffer, newest first. */
export function useAlerts(): AlertSnapshot {
  useEffect(connectAlerts, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Unread badge count: warnings and errors, not informational records. */
export function useAlertCount(): number {
  return useAlerts().alerts.filter((alert) => alert.level !== "info").length;
}
