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
  /** Providers were saved; the masked catalogue arrived. Consumers
   *  refresh the management panel and re-fetch /api/models so the
   *  composer selector shows new groups without a page reload. */
  | { kind: "providers-updated"; providers: unknown[] }
  /** Slice 06 — a subagent was just born or settled. The sidebar
   *  session tree refetches; the chat renderer's `recentSubagents`
   *  list is updated through the next state push. The payload is
   *  empty — the listener decides when to re-read. */
  | { kind: "tree-changed" }
  /** webui-parity 83 — the files ON DISK changed underneath the app, and
   *  the state snapshot carries no such signal: a turn diff revert rewrites
   *  workspace files without touching `chat`, `running` or `config`. The
   *  file tree, the open file preview and the git panel all have to re-read,
   *  and none of them can notice from a snapshot. Like `tree-changed` the
   *  payload is empty — the consumers re-read through the typed API. */
  | { kind: "workspace-files-changed" }
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
  // Provider management (ticket 03): the server broadcasts this after
  // a successful PUT on /api/providers so the management panel and the
  // model selector refresh without polling. The data payload carries
  // the masked providers list — apiKey NEVER plaintext on this path.
  "providers.updated",
  // Slice 06 — Agent Team. The server fires this when a subagent row
  // lands in the runtime db (tool_call → background_tasks.kind =
  // "subagent"), so the sidebar session tree can re-read its cache.
  "session-tree-changed",
  // webui-parity 83 — fired after a turn-diff revert / reapply rewrote
  // workspace files. Registered in the same list so the native EventSource
  // subscription is opened for it; a frame whose event name is absent here
  // is never delivered by the browser at all.
  "workspace-files-changed",
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
    case "providers.updated": {
      // The data payload is `{ version, providers: [publicView(...)] }`.
      // We only forward the `providers` array — the version is just a
      // contract marker for the route handler. Malformed payloads are
      // surfaced rather than thrown so the connection stays live.
      const parsed = parseJson<{ providers?: unknown[] }>(data);
      if (!parsed.ok) return { kind: "malformed", event, detail: parsed.detail };
      const providers = Array.isArray(parsed.value.providers) ? parsed.value.providers : [];
      return { kind: "providers-updated", providers };
    }
    case "session-tree-changed": {
      // Slice 06: no payload — the sidebar decides when to re-fetch.
      // The body is `{}` so JSON parsing is a safe no-op; malformed
      // payloads are surfaced so the connection stays live.
      if (data && data.trim() !== "" && data.trim() !== "{}") {
        const parsed = parseJson<unknown>(data);
        if (!parsed.ok) return { kind: "malformed", event, detail: parsed.detail };
      }
      return { kind: "tree-changed" };
    }
    case "workspace-files-changed": {
      // webui-parity 83: no payload — the file tree, the open preview and
      // the git panel each decide what to re-read. Same tolerant parse as
      // `session-tree-changed`; the body is `{}` so this is a safe no-op.
      if (data && data.trim() !== "" && data.trim() !== "{}") {
        const parsed = parseJson<unknown>(data);
        if (!parsed.ok) return { kind: "malformed", event, detail: parsed.detail };
      }
      return { kind: "workspace-files-changed" };
    }
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
