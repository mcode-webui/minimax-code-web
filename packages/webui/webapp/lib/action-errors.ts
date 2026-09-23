"use client";

import { useEffect, useState } from "react";

/**
 * Action errors — the surface that makes a failed mutation visible.
 *
 * A module store rather than a React context, because the call sites are not
 * all components — the app's global Ctrl+N handler is a plain function. A
 * context would force every caller through a hook, and a hook cannot be used
 * there. Components subscribe with `useActionErrors()`.
 *
 * The API is deliberately two functions:
 *
 *   `runAction(label, promise)`   fire a mutation; a failure becomes a banner
 *   `reportActionError(...)`      report something already caught
 *
 * Callers pass a human label ("切换会话" / "Switching session") so the banner
 * says what failed rather than leaking a status code alone.
 */

export interface ActionError {
  id: number;
  /** What the user was trying to do, already localized by the caller. */
  label: string;
  /** The underlying reason: an Error message or an `HTTP <status>` string. */
  detail: string;
  at: number;
}

// Identical consecutive failures collapse: a retry loop or an impatient
// double-click should not stack five copies of the same banner.
const DEDUPE_WINDOW_MS = 4_000;
// Kept short on purpose — this is a transient notice, not an error log.
const MAX_VISIBLE = 3;

let nextId = 1;
let errors: ActionError[] = [];
const listeners = new Set<(errors: ActionError[]) => void>();

function emit() {
  for (const listener of listeners) listener(errors);
}

/** Human-readable detail for anything thrown by `lib/api`'s `request()`. */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Report a failure the caller already caught. */
export function reportActionError(label: string, cause: unknown): void {
  const detail = describe(cause);
  const now = Date.now();
  const duplicate = errors.find(
    (entry) => entry.label === label && entry.detail === detail && now - entry.at < DEDUPE_WINDOW_MS,
  );
  if (duplicate) return;

  errors = [...errors, { id: nextId++, label, detail, at: now }].slice(-MAX_VISIBLE);
  emit();
}

/**
 * Run a mutation, surfacing a failure instead of swallowing it.
 *
 * Returns the promise so a caller that needs the value can still await it; the
 * common case is fire-and-forget, which is why the failure path is handled here
 * rather than at each call site.
 */
export function runAction<T>(label: string, promise: Promise<T>): Promise<T | undefined> {
  return promise.catch((cause) => {
    reportActionError(label, cause);
    return undefined;
  });
}

export function dismissActionError(id: number): void {
  errors = errors.filter((entry) => entry.id !== id);
  emit();
}

/** Subscribe to the current error list. */
export function useActionErrors(): ActionError[] {
  const [current, setCurrent] = useState<ActionError[]>(errors);
  useEffect(() => {
    // Re-sync on subscribe: an error may have been reported between the initial
    // render and this effect (e.g. from a module-level call during hydration).
    setCurrent(errors);
    const listener = (next: ActionError[]) => setCurrent(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return current;
}
