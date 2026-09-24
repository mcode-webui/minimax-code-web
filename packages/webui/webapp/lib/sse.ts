import type { AuthorizeRequest, TokenFirstRun, WebuiState } from "./types";

/**
 * The event contract of the server's state stream.
 *
 * `GET /api/events` carries two kinds of frame. Unnamed frames (an EventSource
 * `message`) carry the whole state snapshot, which the server throttles and diffs
 * before writing; named frames carry out-of-band control events
 * (`needs_authorization`, `authorization_decided`, `token.first_run`,
 * `auth.token_rotated`, `heartbeat`).
 *
 * The mapping lives here, apart from the React store, so the contract is testable
 * without a DOM or an EventSource — this is the boundary where the ACP bridge's
 * output becomes UI state, and it is worth pinning independently of the component
 * that consumes it.
 */

export type SseAction =
  /** A full snapshot arrived; replace state wholesale (the server diffs already). */
  | { kind: "state"; state: WebuiState }
  /** A tool-approval / plan-review request opened. */
  | { kind: "authorize"; request: AuthorizeRequest }
  /** Every connected tab should mirror the modal closing. */
  | { kind: "authorize-cleared" }
  /** First-ever start: the generated token, until acknowledged. */
  | { kind: "first-run"; payload: TokenFirstRun }
  /** Keepalive; nothing to render. */
  | { kind: "heartbeat" }
  /** A frame we recognise but intentionally do not act on. */
  | { kind: "ignored"; reason: string }
  /** A frame we could not parse. Surfaced so the store can report it. */
  | { kind: "malformed"; event: string; detail: string };

/** Names the server sends as named frames (see server/lib/state-bus.js). */
export const NAMED_EVENTS = [
  "needs_authorization",
  "authorization_decided",
  "token.first_run",
  "auth.token_rotated",
  "heartbeat",
] as const;

function parseJson<T>(data: string): { ok: true; value: T } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(data) as T };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Classify one SSE frame.
 *
 * `event` is the frame's event name — `""` for the default `message` event, which
 * is how the snapshot arrives. Unknown names are ignored rather than treated as
 * errors: the server is free to add events, and an older client should keep working
 * (the same forward-compatibility rule the server applies to missing ACP methods).
 */
export function parseSseFrame(event: string, data: string): SseAction {
  switch (event) {
    case "":
    case "message": {
      const parsed = parseJson<WebuiState>(data);
      if (!parsed.ok) return { kind: "malformed", event, detail: parsed.detail };
      return { kind: "state", state: parsed.value };
    }
    case "needs_authorization": {
      const parsed = parseJson<AuthorizeRequest>(data);
      if (!parsed.ok) return { kind: "malformed", event, detail: parsed.detail };
      return { kind: "authorize", request: parsed.value };
    }
    case "authorization_decided":
      // The payload is informational; the modal just closes.
      return { kind: "authorize-cleared" };
    case "token.first_run": {
      const parsed = parseJson<TokenFirstRun>(data);
      if (!parsed.ok) return { kind: "malformed", event, detail: parsed.detail };
      return { kind: "first-run", payload: parsed.value };
    }
    case "heartbeat":
      return { kind: "heartbeat" };
    case "auth.token_rotated":
      // The token value is deliberately not read here: it is only needed by the
      // settings surface, which fetches it through the API when it is open.
      return { kind: "ignored", reason: "token rotation is handled by the settings surface" };
    default:
      return { kind: "ignored", reason: `unknown event: ${event || "(none)"}` };
  }
}

/** Apply an action to the connection flags a frame implies, for the store. */
export function isConnectedAction(action: SseAction): boolean | null {
  if (action.kind === "state") return true;
  if (action.kind === "malformed") return null;
  if (action.kind === "heartbeat") return true;
  return null;
}
