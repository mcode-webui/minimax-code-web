// webapp/lib/url-restore.ts
//
// URL-driven session restore (webui-parity 07).
//
// Why this lives in its own module:
//   `?session=<id>` is the entry point for three different callers:
//     1. **Cold load** — user clicks a deep link, ?session=X is in the URL,
//        the page has not yet rendered. We must call `switchSession(X)` before
//        the SSE snapshot lands so the server's `mcodeSessionId` matches
//        the link the user clicked.
//     2. **Back / forward** — `popstate` fires with the restored URL; we
//        switch if and only if the snapshot's active session is still
//        different from the URL's claim. Server wins.
//     3. **In-tab navigation** — `switchSession` from the sidebar; we keep
//        the URL in sync via `replaceState` so a refresh lands on the same
//        session. `replaceState` (not `pushState`) because internal
//        navigation is not a "history entry" the user expects to back out of.
//
//   All three route through one helper (`parseSessionFromUrl`) so the
//   URL grammar ("session=…", no path version, no fragment) lives in
//   exactly one place. Bumping to a path segment later is one
//   replacement here rather than three places to keep in lockstep.
//
// Invalid-session handling (acceptance criterion 2):
//   When the URL names a session id that no longer exists, the server
//   returns 404 from `POST /api/sessions/switch`. The page must NOT
//   silently jump back to the home screen — that is the exact failure
//   mode the ticket listed. We instead surface a small "session not
//   found" hint (see `UiHintBanner`) and only THEN drop the URL, so the
//   user knows what happened.

import * as api from "./api";
import type { PanelKind } from "./persist";

/** The query parameter name carrying the active session id. */
export const SESSION_QUERY = "session";

/**
 * Deep-link href for a session row (webui-parity 47, S8).
 *
 * The app's URL grammar is the `?session=` query parameter above — NOT the
 * reference's `#session=` fragment. The restore pipeline (cold load,
 * popstate, replaceState sync) is keyed on the query string, and
 * `writeSessionToUrl` deliberately preserves whatever fragment is present,
 * so a `#session=` href would linger beside the query parameter and the two
 * grammars would fight. Sourcing the href from `SESSION_QUERY` keeps the
 * row markup and the parser from drifting apart.
 */
export function sessionHref(sessionId: string): string {
  return `?${SESSION_QUERY}=${encodeURIComponent(sessionId)}`;
}

/** Best-effort read of the `?session=` value. Empty/undefined when
 *  none was set or the value was malformed (whitespace-only). */
export function parseSessionFromUrl(href?: string): string | null {
  const source = typeof href === "string" ? href : (typeof window !== "undefined" ? window.location.href : "");
  if (!source) return null;
  try {
    const url = new URL(source, "http://placeholder.invalid/");
    const value = url.searchParams.get(SESSION_QUERY);
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export interface SessionRestoreOutcome {
  /** What the page should do after the call resolves. */
  status: "ok" | "not-found" | "no-op" | "error";
  /** Validated session id (echo of what we asked to switch to). */
  sessionId: string | null;
  /** Server-provided message (404 body, network error, etc.). Useful
   *  for the "not found" / "error" hint copy. */
  message?: string;
}

/** Server side of URL restore: switch to the requested session if it
 *  exists, otherwise return a non-destructive error so the caller
 *  can show a hint instead of silently dropping the user to the home
 *  screen.
 *
 *  `currentActiveId` is the SSE snapshot's `mcodeSessionId` at the
 *  moment we make this call. If it already matches, we skip the
 *  round-trip — this keeps the cold-load path zero-cost when the
 *  user lands on the same session they were already on. */
export async function applySessionRestore(
  desiredId: string | null,
  currentActiveId: string | null,
): Promise<SessionRestoreOutcome> {
  if (!desiredId) {
    return { status: "no-op", sessionId: null };
  }
  if (currentActiveId && currentActiveId === desiredId) {
    return { status: "no-op", sessionId: desiredId };
  }
  try {
    const res = await api.switchSession(desiredId);
    if (res && res.ok === true) {
      return { status: "ok", sessionId: desiredId };
    }
    // The server returned `{ok:false, error:...}` (e.g. 200 with
    // a soft-fail body). Treat its message as the canonical signal.
    const message = (res as { error?: string } | null)?.error ?? "session not found";
    return { status: classifyOutcome(message), sessionId: desiredId, message };
  } catch (cause) {
    // The typed `request()` helper throws an Error whose `.message`
    // is either the server's `error` field (for application-layer
    // 4xx) or `HTTP <status>` (for transport-layer failures, where
    // we never set a `.status` property). So we have to inspect the
    // message to recognise a 404.
    const raw = cause instanceof Error ? cause.message : String(cause);
    return {
      status: classifyOutcome(raw),
      sessionId: desiredId,
      message: raw,
    };
  }
}

/**
 * Classify an error message into one of the page-side outcomes.
 *
 * Two signals identify "this id no longer exists":
 *   * `.status === 404` on the thrown error — only when callers
 *     attach one;
 *   * the canonical server text "not found" (case-insensitive),
 *     which is what the typed request helper surfaces for a 404
 *     from `POST /api/sessions/switch`.
 *
 * Anything else is a generic error so the hint banner copy stays
 * honest about the cause.
 */
function classifyOutcome(message: string | null | undefined): SessionRestoreOutcome["status"] {
  if (typeof message !== "string" || message.length === 0) return "error";
  // Numeric status — only fires when a `.status` made it onto the
  // error. The "session not found" body of the typed request helper
  // also passes through here when callers strip the status; that is
  // the deliberate fallback.
  if (/\b404\b/.test(message)) return "not-found";
  if (/not\s*found/i.test(message)) return "not-found";
  return "error";
}

/** Write the active session into the URL without a history entry.
 *  No-op when the URL already carries the same id. */
export function writeSessionToUrl(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (sessionId) {
    if (url.searchParams.get(SESSION_QUERY) === sessionId) return;
    url.searchParams.set(SESSION_QUERY, sessionId);
  } else {
    if (!url.searchParams.has(SESSION_QUERY)) return;
    url.searchParams.delete(SESSION_QUERY);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  // `replaceState` so the back button does not return the user to
  // every intermediate session — internal navigation is not a "page".
  try {
    window.history.replaceState(null, "", next);
  } catch {
    /* static export with a file:// scheme can throw — the in-memory
       state still carries the right `mcodeSessionId` so a subsequent
       `replaceState` from a real browser restores it. */
  }
}

/** Strip the `?session=` argument. Same call site as
 *  `writeSessionToUrl(null)` but kept separate so the
 *  "after an invalid id" path reads as an explicit "drop the bad
 *  hint from the URL" rather than a parameterless "clear". */
export function dropSessionFromUrl(): void {
  writeSessionToUrl(null);
}

/** Read the current `?session=` so the page can present a "deep
 *  link candidate" hint when nothing else applies. Convenience over
 *  `parseSessionFromUrl(window.location.href)` for callers that have
 *  the URL already. */
export function getSessionFromWindow(): string | null {
  return parseSessionFromUrl();
}

// --- type-only re-export so the page module only needs one import. ---
export type { PanelKind };
