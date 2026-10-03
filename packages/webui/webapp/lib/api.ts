import type { WebuiState } from "./types";
import { withClientQuery } from "./cid";

/**
 * Typed client for the webui server's HTTP API.
 *
 * Request and response shapes below are copied from packages/webui/docs/API.md.
 *
 * All calls are relative: the page is served by the same origin as the API, and
 * `next dev` proxies /api/* to the Node server (see next.config.mjs). Every call
 * carries the client id and, when present, the auth token (see lib/cid.ts).
 */

export interface ApiResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/**
 * The request deadline elapsed before any response arrived.
 *
 * Why this is a type and not just a message. `POST /api/send` answers with an
 * acknowledgement and then runs the turn (see `routes/chat.js#handleSend`: the
 * 200 is written at the top, the engine work follows). A deadline that expires
 * therefore says NOTHING about whether the engine received the prompt — the
 * request can be on the server and executing while the browser is still
 * waiting, and a stalled dev proxy or a busy event loop is enough to cause it.
 *
 * The old code flattened this into `new Error("no response within 30000ms")`,
 * the composer showed it as a red "message failed" banner, put the text back
 * in the box, and the user's next Enter ran the turn a second time
 * (webui-parity 81 D-2: `sleep 35` executed twice). Reporting the timeout as a
 * failure is a lie about a side effect that may already have happened, and the
 * refill is what turned the lie into a duplicate execution.
 *
 * The caller branches on `isSendUnconfirmed` and resolves the real question —
 * did the turn start? — against the server (see `lib/send-confirmation.ts`).
 * The `message` is kept for logs and for callers that only want a string; it
 * is never rendered as a user-facing verdict.
 */
export class SendUnconfirmedError extends Error {
  /** Structural marker. Read through `isSendUnconfirmed`, never by message. */
  readonly unconfirmed = true;
  /** The deadline that elapsed, for copy that names the real number. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no response within ${timeoutMs}ms`);
    this.name = "SendUnconfirmedError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * True when `cause` is the deadline error above.
 *
 * The `unconfirmed` flag is read structurally rather than through
 * `instanceof`: the api module is imported by both the app bundle and the
 * vitest suites, and a second copy of the class (two realms, a re-bundled
 * module) would make `instanceof` answer false for a real timeout.
 */
export function isSendUnconfirmed(cause: unknown): cause is SendUnconfirmedError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { unconfirmed?: unknown }).unconfirmed === true
  );
}

/**
 * A non-2xx answer from the API, with its status and machine-readable
 * `reason` kept.
 *
 * Why the status matters: the composer's banner is chosen by WHAT the
 * server decided, not by the wording of its message. A 409 whose `reason`
 * is `cid-busy` / `session-busy` is the server saying "this conversation
 * is already running, your message was not delivered" — a different fact
 * from "your send failed" (retrying is wrong for one, right for the other)
 * and a completely different fact from "the engine may already be running
 * it, do not resend". Before this type the 409 arrived as a bare
 * `new Error(string)`, so the composer could only render it as a generic
 * failure and the user read a refused send as a broken one (P16).
 *
 * The `reason` is optional: an endpoint that answers 4xx without one (a
 * malformed body, an older server) still produces a usable `ApiHttpError`,
 * and the composer falls back to the generic banner for it.
 *
 * The `code` is the same idea one layer in, and it is NOT a rename of
 * `reason`: `reason` is the composer's "which banner" vocabulary
 * (`cid-busy`, `session-busy`), while `code` is an endpoint's own
 * machine key — the engine's refusal code forwarded verbatim by
 * `/api/model-source` (`NO_API_KEY` means "save a key first", which is a
 * pointer, not a failure). A response may carry either, both or neither,
 * and every existing consumer of `reason` is unaffected.
 */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly reason: string | null;
  /** The endpoint's own machine key, when its failure body carried one. */
  readonly code: string | null;

  constructor(
    status: number,
    message: string,
    reason: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.reason = reason;
    this.code = code;
  }
}

/**
 * The endpoint's machine `code` carried by an `ApiHttpError`, or `null`.
 *
 * Read structurally, like `isConversationBusy` above, so a second copy of
 * the class across module realms still answers correctly.
 *
 * @param cause The rejected value.
 * @param code The code being looked for, e.g. `"NO_API_KEY"`.
 */
export function hasApiErrorCode(cause: unknown, code: string): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === code;
}

/**
 * The server's stable machine key for "this conversation is already
 * running a turn", or null for any other answer.
 *
 * Read structurally (like `isSendUnconfirmed`) so a second copy of the
 * class across module realms still answers correctly.
 */
export function isConversationBusy(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const http = cause as { status?: unknown; reason?: unknown };
  if (http.status !== 409) return false;
  return http.reason === "cid-busy" || http.reason === "session-busy";
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown; timeoutMs?: number },
): Promise<T> {
  const { json, timeoutMs, ...rest } = init ?? {};
  // Only the callers that pass `timeoutMs` get a deadline. A hung request
  // otherwise never settles, and the composer keeps its `sending` flag set
  // forever — the text stays in the box and Enter silently stops working.
  const controller = timeoutMs === undefined ? null : new AbortController();
  const timer =
    controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(withClientQuery(path), {
      ...rest,
      ...(controller === null ? {} : { signal: controller.signal }),
      headers: {
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
        ...rest.headers,
      },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
  } catch (cause) {
    if (controller?.signal.aborted) {
      throw new SendUnconfirmedError(timeoutMs as number);
    }
    throw cause;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means the request never reached the API layer — the LAN
    // gate returns an HTML page, and a 404 returns plain text.
    throw new Error(response.ok ? "unexpected non-JSON response" : `HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    const reason =
      payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string"
        ? String((payload as { reason: string }).reason)
        : null;
    const code =
      payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "string"
        ? String((payload as { code: string }).code)
        : null;
    throw new ApiHttpError(response.status, message, reason, code);
  }
  return payload as T;
}

// --- state and health -------------------------------------------------------

/**
 * `GET /api/state` — the server's own view of this cid.
 *
 * `timeoutMs` exists for the send-confirmation probe
 * (`lib/send-confirmation.ts`), which has a hard budget of its own and must not
 * inherit an unbounded fetch. Normal callers pass nothing.
 */
export const getState = (timeoutMs?: number) =>
  request<WebuiState>("/api/state", timeoutMs === undefined ? undefined : { timeoutMs });

export interface Health {
  ok: boolean;
  [key: string]: unknown;
}
export const getHealth = () => request<Health>("/api/health");

// --- chat -------------------------------------------------------------------

export interface SendPayload {
  content: string;
  /** `@path` references to prepend; the attachment UI supplies these. */
  attachments?: string[];
  /** Set when the content answers an active `ask_user` question. */
  isAskAnswer?: boolean;
}

// Deadline for the two send endpoints' acknowledgement.
//
// It was NOT raised. A longer deadline only moves the same false negative
// further out (webui-parity 81 D-2), and it cannot be fixed by a deadline at
// all: the deadline measures the ROUND TRIP, while the question the composer
// actually has to answer is whether the ENGINE TOOK THE PROMPT. Those are
// different questions — the turn is already running while the browser is still
// waiting. So the deadline is kept at a value that fails fast enough for the
// user to get an answer, and the timeout path resolves the real question
// against the server before deciding what to show or restore
// (`lib/send-confirmation.ts`).
const SEND_ACK_TIMEOUT_MS = 30_000;

export const sendMessage = (payload: SendPayload) =>
  request<{ ok: boolean }>("/api/send", {
    method: "POST",
    json: payload,
    timeoutMs: SEND_ACK_TIMEOUT_MS,
  });

export const stopRun = () => request<{ ok: boolean }>("/api/stop", { method: "POST", json: {} });

/**
 * The follow-up message a send-while-running is handed to
 * (`POST /api/follow-up`, settings batch SB-4).
 *
 * `behavior` is the value of `webui-follow-up-behavior` the composer is
 * following, and the server validates it against the same two engine
 * actions — a browser is not trusted to have read the right key, and the
 * OFF position never reaches here at all. `requestId` is the per-send
 * identity: it is forwarded to the engine as the queue item's
 * `clientRequestId` and as the steering message's `idempotencyKey`, so a
 * retried click cannot produce two messages.
 */
export interface FollowUpPayload {
  behavior: "queue" | "steer";
  content: string;
  attachments?: string[];
  requestId?: string;
}

/** What the ENGINE reported back — never an echo of the request: the
 *  queue position, or the turn the message was steered into. */
export interface FollowUpResult {
  ok: boolean;
  behavior: "queue" | "steer";
  itemId?: string;
  /** Queue answers: 0-based position behind the items ahead. */
  position?: number;
  /** Steer answers: the turn the message was delivered into. */
  turnId?: string;
}

// The same acknowledgement deadline as the two send endpoints, and for
// the same reason: a deadline that expires says nothing about whether the
// engine took the message, so the composer restores the text instead of
// claiming a failure it cannot prove. See `SendUnconfirmedError`.
export const submitFollowUp = (payload: FollowUpPayload) =>
  request<FollowUpResult>("/api/follow-up", {
    method: "POST",
    json: payload,
    timeoutMs: SEND_ACK_TIMEOUT_MS,
  });

/** Raw slash command (e.g. `/compact`), forwarded to mcode. */
export const sendCommand = (cmd: string) =>
  request<{ ok: boolean }>("/api/cmd", {
    method: "POST",
    json: { cmd },
    timeoutMs: SEND_ACK_TIMEOUT_MS,
  });

// `/api/cmd` is the one send endpoint that does NOT acknowledge before it
// works: it answers after the dispatcher has run, so its deadline covers the
// command itself (`/help` waits on the engine's command list). It shares the
// same unconfirmed-error path — a timeout there means the command may already
// have written its output, and saying "failed" would be equally untrue.

// --- sessions ---------------------------------------------------------------

export interface SessionRow {
  id: string;
  title?: string;
  workspace?: string;
  mcodeSessionId?: string;
  updatedAt?: number;
}

export const listSessions = () =>
  request<{ ok: boolean; count: number; sessions: SessionRow[] }>("/api/sessions");

export const newSession = (workspace?: string) =>
  request<{ ok: boolean; id: string }>("/api/sessions", {
    method: "POST",
    json: workspace ? { workspace } : {},
  });

/**
 * Activate a session.
 *
 * The response carries the session the engine actually landed on, not only an
 * acknowledgement: webui-parity 63 has the caller compare it against the row
 * the user clicked, because a switch that quietly lands somewhere else looks
 * exactly like one that worked.
 */
export const switchSession = (id: string) =>
  request<{
    ok: boolean;
    session?: { id: string; mcodeSessionId: string | null; title: string };
  }>("/api/sessions/switch", { method: "POST", json: { id } });

export const deleteSession = (id: string) =>
  request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * Rename a session (CRUD "update"). Records the title as user-authoritative
 * (`titleCustom`), so mcode's automatic title generation stops overwriting it.
 * `id` accepts a webui uuid as well as an `mvs_…` id.
 */
export const renameSession = (id: string, title: string) =>
  request<{ ok: boolean; session?: { id: string; title: string; titleCustom?: boolean } }>(
    "/api/sessions/rename",
    { method: "POST", json: { id, title } },
  );

// --- session tree -----------------------------------------------------------

/**
 * The sidebar's Project → directory → session → subagent tree.
 *
 * Built server-side from mcode's runtime db; see `server/lib/session-tree.js`
 * for the level mapping. `ok:false` with a `reason` is a normal soft failure
 * (the runtime db is missing or unreadable) — there is no error field, because
 * none of those cases is a transport error.
 */
export interface TreeSession {
  /** `mvs_…` id — accepted directly by `POST /api/sessions/switch`. */
  id: string;
  title: string;
  /** `mavis` for a main session, `worker` / `explore` / `verifier` for a subagent. */
  agent: string;
  kind: string;
  status: string;
  updatedAt: number;
  /**
   * Whether the engine's `PinService` currently pins this session.
   *
   * Always present, `false` included: the server lays the pin overlay
   * over the whole tree rather than only over the pinned rows, so the
   * client reads a boolean and never has to know the id set exists.
   */
  pinned: boolean;
  /** Subagents this session spawned. Only present on level-3 entries. */
  children: TreeSession[];
}

export interface TreeDirectory {
  path: string;
  name: string;
  latestAt: number;
  sessions: TreeSession[];
}

export interface TreeProject {
  key: string;
  name: string;
  /** Repository roots folded into this project, for the row's tooltip. */
  repoPaths: string[];
  latestAt: number;
  sessionCount: number;
  directories: TreeDirectory[];
}

export interface SessionTreePayload {
  ok: boolean;
  reason?: string;
  detail?: string;
  truncated?: boolean;
  counts?: { projects: number; directories: number; sessions: number };
  projects?: TreeProject[];
  /**
   * How the pin overlay was resolved — present only on a successful tree.
   *
   * `degraded: true` means the engine could not be asked which sessions
   * are pinned, so every `pinned` on this payload is `false` because the
   * answer is unknown, not because nothing is pinned. The sidebar does
   * not branch on it today (an unavailable pin section is a cosmetic
   * loss, not a failure — see `readEnginePinnedSessionOrder`), and the
   * field exists so that decision is visible rather than implied.
   */
  pins?: { pinnedIds: string[]; degraded: boolean; reason: string | null };
}

// --- filesystem -------------------------------------------------------------

/**
 * One directory listing.
 *
 * `GET /api/fs/read?path=<dir>` is a **scandir**, not a file reader — pointing it
 * at a file returns `ENOTDIR`. So this backs a directory navigator, and there is
 * no file-content endpoint to build a viewer on.
 */
export interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "file" | string;
  size: number;
  mtime: number;
  mode: string;
  icon: string;
}

export interface FsListing {
  ok: boolean;
  path?: string;
  parent?: string | null;
  home?: string;
  entries?: FsEntry[];
  skipped?: number;
  total?: number;
  error?: string;
}

export const getFsDir = (path: string, showHidden = false) =>
  request<FsListing>(
    `/api/fs/read?path=${encodeURIComponent(path)}${showHidden ? "&showHidden=1" : ""}`,
  );

/**
 * One match returned by the bounded workspace search endpoint
 * (webui-parity slice 19a → `GET /api/fs/search`). The shape is pinned
 * by the server route in `server/routes/fs.js#handleFsSearch` and the
 * walker in `server/lib/fs-search.js#searchWorkspace` — do not rename
 * fields without migrating the assertions in
 * `server/test/fs-search.test.js` (the 20/20 glob-parity invariant) and
 * the webapp tripwires in `webapp/test/fs-search.test.ts`.
 *
 * `ancestors` is the chain of directory basenames between the search
 * root (exclusive) and the match's parent (exclusive). The webapp
 * uses it to expand the tree to the hit. A top-level match has
 * `ancestors: []`.
 *
 * `credential` is the slice-16 flag: a match whose realpath basename
 * matches `lib/credential-file.js`'s predicate. `credentialReason`
 * is the sub-reason (`dotenv` / `key-file` / `ssh-key` / `credentials`
 * / `ssh-meta`) the right-panel preview also uses.
 */
export interface FsSearchMatch {
  path: string;
  name: string;
  type: "file" | "dir" | string;
  ancestors: string[];
  credential?: boolean;
  credentialReason?: "dotenv" | "key-file" | "ssh-key" | "credentials" | "ssh-meta" | string;
}

export interface FsSearchSkipped {
  "node_modules": number;
  ".git": number;
  credential: number;
  huge: number;
  /** Per-name skip counts for OPTIONAL_SKIP_DIRS (dist / build / …). */
  optional: Record<string, number>;
}

export interface FsSearchBudgets {
  maxDepth: number;
  maxNodes: number;
  wallMs: number;
  maxMatches: number;
  includeHidden: boolean;
  includeDirs: string[];
}

/**
 * Wire shape of `GET /api/fs/search` — slice 19a. The route mirrors
 * `lib/fs-search.js#emptyResult`, with the addition of `ok: true`
 * on the success path. The webapp treats `ok: false` (or an HTTP
 * error) as a search failure and renders the error inline.
 *
 * `truncated` flips to `true` iff a budget fired. `truncatedReason`
 * names the budget. `skipped.huge` can be non-zero WITHOUT
 * `truncated` being true (a single directory's tail was deliberately
 * capped while the walk itself finished within budgets) — the UI
 * MUST surface both signals honestly so the user is never told
 * "that's everything" when it is not.
 */
export interface FsSearchResult {
  ok: true;
  root: string;
  q: string;
  matches: FsSearchMatch[];
  scanned: { dirs: number; files: number; total: number };
  skipped: FsSearchSkipped;
  truncated: boolean;
  truncatedReason: "depth" | "nodes" | "wallClock" | "matches" | null;
  elapsedMs: number;
  budgets: FsSearchBudgets;
}

/**
 * Optional client-side budget overrides. Every value is clamped to
 * the server's `ABSOLUTE_LIMITS` so a malicious or buggy client
 * cannot pin a core — see `server/lib/fs-search.js#clampBudgets`.
 * Leave a key undefined to take the server default.
 */
export interface FsSearchOpts {
  /** Abort signal so callers can cancel an in-flight request when
   *  the user keeps typing. The request helper propagates the
   *  signal to `fetch`. */
  signal?: AbortSignal;
  depth?: number;
  maxNodes?: number;
  wallMs?: number;
  /** Per-page result cap. `maxMatches` is the server's name;
   *  `limit` is the wire alias the route accepts. */
  limit?: number;
  includeHidden?: boolean;
}

/**
 * Bounded workspace search (slice 19a). Walks the workspace behind
 * the same `assertWorkspacePath` gate every other `/api/fs/*` route
 * uses, with hard budgets so the user cannot ask the server to
 * walk 50 000 nodes for an answer that came back 20 entries ago.
 *
 * The webapp calls this when the in-tree filter has no matches in
 * already-loaded nodes (see `panels.tsx#FilesPanel`'s
 * `triggerServerSearch`). The caller supplies an AbortSignal so a
 * new keystroke can cancel the previous in-flight request without
 * flooding the network.
 */
export const searchFs = (root: string, q: string, opts: FsSearchOpts = {}) => {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("q", q);
  if (opts.depth !== undefined) params.set("depth", String(opts.depth));
  if (opts.maxNodes !== undefined) params.set("maxNodes", String(opts.maxNodes));
  if (opts.wallMs !== undefined) params.set("wallMs", String(opts.wallMs));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.includeHidden) params.set("includeHidden", "1");
  return request<FsSearchResult>(`/api/fs/search?${params.toString()}`, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
};

export const getSessionTree = (refresh = false) =>
  request<SessionTreePayload>(`/api/session-tree${refresh ? "?refresh=1" : ""}`);

// --- session right-click actions (PB-1) --------------------------------------
//
// The four endpoints behind 归档 / 置顶 / 复制为新会话. Each returns the
// server's own payload and, on failure, THROWS — `request()` turns a
// non-2xx into an `HTTP <status>` error, so a 501 from a provider that
// cannot archive reaches `runAction`'s error path instead of being
// rendered as a successful click. That is the property #110 established
// and the reason none of these four returns a bare `{ok:false}`.

/**
 * Archive or unarchive one session.
 *
 * `archived` defaults to `true`; the engine's `archiveSession` covers
 * both directions in one method, so the flag selects rather than
 * separates. An archived session leaves the sidebar on the next tree
 * read and is restorable by calling this again with `archived: false`.
 */
export const archiveSession = (id: string, archived = true) =>
  request<{ ok: boolean; id: string; archived: boolean }>(
    `/api/sessions/${encodeURIComponent(id)}/archive`,
    { method: "POST", json: { archived } },
  );

/**
 * Pin or unpin one session. The flag is required and is not defaulted:
 * the menu item is a toggle, and a defaulted flag would move the row in
 * a direction the user did not pick.
 *
 * The response carries the engine's whole pinned set, in the engine's
 * order, so a caller can re-render without a second tree read.
 */
export const pinSession = (id: string, pinned: boolean) =>
  request<{ ok: boolean; id: string; pinned: boolean; pinnedIds: string[] }>(
    `/api/sessions/${encodeURIComponent(id)}/pin`,
    { method: "POST", json: { pinned } },
  );

/** What a fork of this session would be, before the user commits to one. */
export interface SessionForkOptions {
  ok: boolean;
  id: string;
  canFork: boolean;
  unavailableReason: string | null;
  suggestedTitle: string | null;
  nextForkOrdinal: number | null;
  sourceTitle: string | null;
  /**
   * The engine's worktree eligibility, carried through untouched.
   *
   * Read by nobody in this batch: the worktree variant of the menu has
   * no desktop reference to build against, so it stays an honest
   * placeholder. The fields travel so the batch that unblocks it does
   * not need a second round trip.
   */
  worktree: { visible: boolean; eligible: boolean; unavailableReason: string | null };
}

export const getSessionForkOptions = (id: string, assistantMessageId?: string) =>
  request<SessionForkOptions>(
    `/api/sessions/${encodeURIComponent(id)}/fork-options` +
      (assistantMessageId
        ? `?assistantMessageId=${encodeURIComponent(assistantMessageId)}`
        : ""),
  );

/**
 * Duplicate this conversation as a new session in the same workspace.
 *
 * `assistantMessageId` is the fork POINT; omitted, the whole
 * conversation is duplicated, which is what the menu item means when
 * the user has not picked a message. The created session's id comes
 * back so the caller can switch to it.
 */
export const forkSession = (id: string, assistantMessageId?: string) =>
  request<{ ok: boolean; id: string; sourceId: string; forkOriginMessageId: string | null }>(
    `/api/sessions/${encodeURIComponent(id)}/fork`,
    { method: "POST", json: assistantMessageId ? { assistantMessageId } : {} },
  );

// --- model and permissions --------------------------------------------------

/**
 * One entry in the model catalogue.
 *
 * `id` is the wire id (`minimax_api/MiniMax-M3`, or — when the engine session
 * is active — its encoded `m:<provider>:<model>:v:<variant>` form). `label`
 * is the display name; provider-grouped menus render this rather than the id.
 * `provider` is the prefix before the first `/` (`minimax_api`, `openai_compat`,
 * `__engine`, …) — `groups[]` is keyed by it so a UI can render per-provider
 * sections. `source` is which list this entry came from (`engine` /
 * `config` / `builtin`); informational.
 *
 * `contextLimit` is optional: it surfaces when a provider's
 * `MCODE_WEBUI_MODELS_CONFIG` entry declares one, and is `undefined`
 * otherwise (the engine's own per-session `usage_update.size` is preferred
 * once one exists).
 *
 * v2 schema fields (ticket 01, surfaced for the selector in ticket 04):
 *   * `protocol` — the wire protocol the model is reachable through
 *     (`openai` / `anthropic` / `gemini`); the engine-sourced group
 *     does not advertise one, so it's optional.
 *   * `thinkingLevels` — the reasoning-effort levels the engine accepts
 *     on this model (`["low", "medium", "high"]`, optionally including
 *     `"off"`). When non-empty, the composer renders a level picker
 *     alongside the model selector (ticket 04).
 *   * `modalities` — the modality badges the model claims (`text` /
 *     `image` / `audio` / `video`). Rendered as small chips next to
 *     the model label.
 */
export interface ModelEntry {
  id: string;
  name?: string;
  label?: string;
  provider?: string;
  source?: "engine" | "config" | "builtin";
  contextLimit?: number;
  protocol?: "openai" | "anthropic" | "gemini";
  thinkingLevels?: string[];
  modalities?: string[];
  /** Context-window choices in tokens (U6), from the engine's
   *  materialised builtin tree. Absent for models with nothing to
   *  pick — the composer mounts no control then. */
  contextWindowOptions?: number[];
  /** Per-option presentation hints; today only `higher_usage`. */
  contextWindowOptionHints?: Record<string, string>;
}

/**
 * Auth view the catalogue carries per provider group.
 *
 * Mirrors the masked `auth` block on `/api/providers` (apiKey NEVER
 * appears — only `hasKey` + `type`); see
 * `server/routes/model.js#handleGetModels` for the masking rule.
 */
export interface ModelGroupAuth {
  /** True when the provider has an API key configured. Groups with
   *  `hasKey === false` render greyed with a "configure in Settings"
   *  hint so the user can fix it without opening the management
   *  panel. */
  hasKey: boolean;
  type: "byok" | "coding-plan";
}

export interface ModelGroup {
  id: string;
  label: string;
  models: ModelEntry[];
  /** Auth view — present on provider-config groups, absent on the
   *  engine session group (which is always usable). */
  auth?: ModelGroupAuth;
  protocol?: "openai" | "anthropic" | "gemini";
}

export interface ModelsPayload {
  ok: boolean;
  /** `id` of the active model, or `null`/`DEFAULT_MODEL` fallback when none recorded. */
  current: string;
  models: ModelEntry[];
  /** Per-provider groups; same models appear in `models[]` flat too. */
  groups: ModelGroup[];
  /** Current thinking-effort level (engine's `thinkingEffort.currentValue`,
   *  falling back to `cs.model.thinking`, then `null`). The composer
   *  reads this to highlight the active level in the picker. */
  currentThinking?: string | null;
  /** The context window in tokens the picker should highlight (U6):
   *  the recorded `cs.model.contextWindow`, falling back to the
   *  current model's catalogue `contextLimit`, then `null`. */
  currentContextWindow?: number | null;
  /** One of `acp-session-config` / `config+mcode-cli-bundle` / `mcode-cli-bundle`. */
  source?: string;
  reason?: string;
}

export const listModels = () => request<ModelsPayload>("/api/models");

// --- providers --------------------------------------------------------------
//
// Provider management UI surface (ticket 03). The server carries a v2
// schema with three layers (env / cwd / user), masked keys, and a
// per-protocol connectivity probe — see `server/lib/providers-config.js`
// for the load-bearing details.
//
// `apiKey` is NEVER returned in plaintext — the response uses
// `apiKeyMasked` (first-N + *** + last-N framing). The PUT body uses
// `auth.apiKey === ""` as the keep-existing-key sentinel (a UI that
// didn't touch the key field sends an empty string, the route copies
// the on-disk key onto the record before validation). The two
// conventions together mean the masked placeholder is the
// placekeeper, not a value to round-trip.

export type ProviderProtocol = "openai" | "anthropic" | "gemini";
export type ProviderAuthType = "byok" | "coding-plan";

export interface ProviderAuthView {
  type: ProviderAuthType;
  hasKey: boolean;
  apiKeyMasked: string;
  baseURL: string;
  /**
   * Extra outbound headers, echoed back verbatim by the server (they
   * are operator-authored routing config, not a masked secret). Always
   * present as an object on a current server; a server older than the
   * field omits it, so treat absence as "none" rather than assuming.
   */
  headers?: Record<string, string>;
}

export interface ProviderModelView {
  id: string;
  label: string;
  contextLimit?: number;
  thinkingLevels?: string[];
  modalities?: string[];
}

export interface ProviderView {
  id: string;
  label: string;
  preset?: string;
  enabled: boolean;
  protocol: ProviderProtocol;
  auth: ProviderAuthView;
  models: ProviderModelView[];
}

export interface ProvidersSnapshot {
  ok: true;
  version: 2;
  providers: ProviderView[];
  sources: { env: string | null; cwd: string | null; user: string };
  userPath: string;
}

export interface ProvidersPutResult {
  ok: true;
  providers: ProviderView[];
  path: string;
}

/**
 * GET /api/providers — the masked catalogue.
 *
 * Used by the management panel and by anything that wants to render a
 * provider's "is this configured" status (the composer already gets
 * `hasKey` from `/api/models`, so this call is panel-only).
 */
export const listProviders = () => request<ProvidersSnapshot>("/api/providers");

/**
 * PUT /api/providers — replace the user-level file with `body`.
 *
 * The body is the full v2 record (same shape `listProviders` returns);
 * the route normalises and validates. `auth.apiKey === ""` on any
 * incoming provider is the keep-existing-key sentinel — see
 * `lib/providers-config.js#applyKeepKeyConvention`.
 */
export const putProviders = (body: {
  version: 2;
  providers: Array<{
    id: string;
    label?: string;
    preset?: string;
    enabled?: boolean;
    protocol: ProviderProtocol;
    auth: {
      type: ProviderAuthType;
      apiKey: string;
      baseURL?: string;
      /** Optional extra outbound headers. Omit or send `{}` for none;
       *  the server rejects a name or value carrying CR/LF/NUL. */
      headers?: Record<string, string>;
    };
    models: Array<{
      id: string;
      label?: string;
      contextLimit?: number;
      thinkingLevels?: string[];
      modalities?: string[];
    }>;
  }>;
}) =>
  request<ProvidersPutResult>("/api/providers", {
    method: "PUT",
    json: body,
  });

export interface ProviderTestResult {
  ok: boolean;
  protocol: string;
  /** OK | INVALID_KEY | BAD_PROTOCOL | PROBE_FAILED */
  code: string;
  error?: string;
  latencyMs?: number;
  detail?: string;
}

/**
 * POST /api/providers/test — connectivity probe.
 *
 * Takes the same `protocol` + `auth` shape as the management form (so
 * the user can test BEFORE saving). `timeoutMs` is optional; the
 * server defaults to 8s. The server returns 200 on success and a
 * structured error otherwise — `request()` throws on non-OK, so this
 * call uses raw fetch to capture the structured body either way.
 */
export async function testProviderConnection(payload: {
  protocol: ProviderProtocol;
  auth: {
    type: ProviderAuthType;
    apiKey: string;
    baseURL?: string;
    /** Carried into the probe request so the test exercises the same
     *  headers the saved provider will send. */
    headers?: Record<string, string>;
  };
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const response = await fetch(withClientQuery("/api/providers/test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: ProviderTestResult | null = null;
  try {
    parsed = text ? (JSON.parse(text) as ProviderTestResult) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new Error(response.ok ? "unexpected non-JSON response" : `HTTP ${response.status}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// SB-1 — the 「用量与模型」 tab's model source.
//
// A separate family from the provider catalogue above, and deliberately
// so: `/api/providers` is webui's OWN store of custom BYOK endpoints
// (`lib/providers-config.js`), while `/api/model-source` is the ENGINE's
// MiniMax credential state (`minimaxModelSource` / `minimax_api.apiKey`
// in the engine's own `config.yaml`, written through `cliService`). The
// two happen to sit on adjacent tabs and share a masking convention; they
// share no storage and no validation.
// ---------------------------------------------------------------------------

/** The two model sources the engine accepts. See `engine/model-source.js`. */
export type ModelSource = "token_plan" | "minimax_api_key";

/**
 * The stored BYOK key's projection. `masked` is the engine's own mask
 * (`service/model-system/secret.js`) — the ONLY shape an apiKey takes on
 * the wire, in this family and in the provider one.
 *
 * `available: false` is not the same as `hasKey: false`: the first means
 * the server could not report the key half at all, the second means it
 * reported that no key is stored. The UI renders them differently, so the
 * type keeps them apart.
 */
export interface ModelSourceApiKeyStatus {
  available: boolean;
  hasKey: boolean;
  masked: string | null;
  /** Engine cache state of the last connectivity probe, when there was one. */
  testState: string | null;
  lastTestedAtMs: number | null;
}

export interface ModelSourceSnapshot {
  ok: true;
  source: ModelSource;
  apiKey: ModelSourceApiKeyStatus;
}

export interface ModelSourcePutResult {
  ok: true;
  source: ModelSource;
  apiKey: ModelSourceApiKeyStatus;
  /** False for a keep (an absent or empty `apiKey`). */
  changed: boolean;
  saveAndUse: boolean;
}

export interface ModelSourceTestStatus {
  state: string | null;
  lastTestedAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface ModelSourceTestResult {
  ok: true;
  /** False means the probe RAN and the model did not answer. */
  success: boolean;
  providerId: string;
  modelId: string | null;
  /**
   * Always `"stored_key"` today: v2's `testUserModel` takes no key
   * override, so the probe can only ever test the saved credential. The
   * field is on the wire so the UI can never imply otherwise.
   */
  tested: "stored_key";
  status: ModelSourceTestStatus;
}

/**
 * GET /api/model-source — the active source plus the key's masked
 * status. Called when the settings tab opens, not at page level: the
 * server boots the engine runtime to answer it, and a boot belongs to a
 * user action.
 */
export const getModelSource = () => request<ModelSourceSnapshot>("/api/model-source");

/**
 * PUT /api/model-source — switch the source.
 *
 * Rejects (throws) with the server's structured `code` when the engine
 * refuses: `NO_API_KEY` means "save a BYOK key first", which the UI
 * renders as a pointer to the key field rather than as a failure.
 */
export const setModelSource = (source: ModelSource) =>
  request<{ ok: true; source: ModelSource }>("/api/model-source", {
    method: "PUT",
    json: { source },
  });

/**
 * PUT /api/model-source/api-key — upsert the BYOK key.
 *
 * `apiKey: ""` is the KEEP sentinel (the server's own convention, the
 * same one `PUT /api/providers` uses): it keeps the stored key and
 * answers `{changed: false}` with the current masked status. It exists
 * because the GET can only return a mask, and the engine rejects a mask
 * submitted as a key — a UI that round-tripped its own state would turn
 * every save into a failure.
 *
 * `saveAndUse` writes the key AND switches the source in one engine
 * transaction.
 */
export const putModelSourceApiKey = (payload: { apiKey: string; saveAndUse?: boolean }) =>
  request<ModelSourcePutResult>("/api/model-source/api-key", {
    method: "PUT",
    json: payload,
  });

/**
 * POST /api/model-source/test — connectivity probe for the stored key.
 *
 * 200 in BOTH outcomes: `success: false` is a completed probe of a model
 * that did not answer, and the caller renders `status` rather than an
 * error. Only a refusal to try (no engine, no such method, no stored
 * key) throws.
 */
export const testModelSourceModel = (payload: { modelId?: string } = {}) =>
  request<ModelSourceTestResult>("/api/model-source/test", {
    method: "POST",
    json: payload,
  });

/**
 * The account card's data, from the engine's `mcode/account/status` method.
 *
 * Display fields and quota figures only: the engine's projection carries no
 * credential and omits the account email on purpose. Fetched on demand rather
 * than carried in the state snapshot, which is broadcast to every SSE
 * subscriber.
 */
/**
 * One metered window of the plan quota, as the engine projects it.
 *
 * `unlimited` is a READING, not an absent figure: an unmetered window says
 * so and carries no percentage. The two are therefore different fields —
 * collapsing them would render 「剩余 0%」 for a plan that has no cap.
 */
export interface AccountQuotaWindow {
  /** Remaining percentage; absent means "the engine sent no figure", not 0. */
  remainingPercent?: number;
  resetAtMs?: number;
  unlimited?: boolean;
}

export interface AccountPayload {
  ok: boolean;
  /** Set when `ok` is false — the account surface is unreachable, not empty. */
  reason?: string;
  status?: "ready" | "needs-login" | "warning" | "unknown";
  authMode?: string;
  modelSource?: "token-plan" | "byok";
  defaultModel?: string;
  managedTokenPresent?: boolean;
  identity?: { name?: string };
  tokenPlanQuotaState?: "available" | "not-subscribed" | "unavailable";
  tokenPlan?: { tier?: string; expiresAtMs?: number; creditBalance?: string };
  /**
   * Per-window quota figures, carried by the engine's account projection
   * (`packages/tui/src/acp/extensions.ts#projectAccountStatus`) and spread
   * through `GET /api/account` verbatim. Typed here because the settings
   * account section reads them as TEXT readings; the limit BARS stay on the
   * Token Plan card, which reads its own `POST /api/usage` snapshot.
   */
  quota?: {
    fiveHour?: AccountQuotaWindow;
    weekly?: AccountQuotaWindow;
  };
  warnings?: string[];
}

export const getAccount = () => request<AccountPayload>("/api/account");

/**
 * Set the active model and (optionally) the thinking-effort level and
 * the context-window choice.
 *
 * Body shape: `{ model?: string, thinking?: string, contextWindow?: number | null }`.
 * The three are independent — a thinking-only update leaves the model
 * alone (the engine contract is "model selected before thinkingEffort";
 * the server enforces the order at apply time), and a model-only update
 * leaves the recorded effort intact so the next session boot re-applies
 * it through `applyRecordedModel`. An empty `thinking` clears the
 * recorded effort (engine's default stands).
 *
 * `contextWindow` (U6) is the context-window choice in tokens — one of
 * the active model's `contextWindowOptions` from /api/models — or
 * `null` to clear the recorded choice. The server records it in
 * `cs.model.contextWindow` and echoes it through /api/models'
 * `currentContextWindow`; the engine's ACP surface has no channel for
 * it yet, so the picker's radio is a webui-recorded preference (see
 * server/routes/model.js#handleSetModel for the verified engine-side
 * boundary).
 */
export const setModel = (
  payload: { model?: string; thinking?: string; contextWindow?: number | null },
) =>
  request<{
    ok: boolean;
    model?: string;
    thinking?: string;
    contextWindow?: number | null;
    mcodeSynced?: boolean;
    thinkingSynced?: boolean;
    warning?: string;
  }>("/api/set-model", {
    method: "POST",
    json: payload,
  });

/**
 * Change the session's permission mode.
 *
 * The body key is `mode` because that is what `handleSetPermissions` reads
 * (`server/routes/model.js`, which documents `{ mode: 'ask'|'auto'|'read'|'full' }`).
 * This used to send `permissions`, which the route does not look at: it fell
 * through to its `full` default, so *every* choice — including "Ask" — silently
 * applied `bypassPermissions`. See `webapp/test/api-permissions.test.ts`.
 */
export const setPermissions = (mode: string) =>
  request<{ ok: boolean }>("/api/permissions", { method: "POST", json: { mode } });

// There is deliberately NO client for `POST /api/answer`.
//
// It used to export `answer(type, option)`, and the ask / plan modals called
// it. `server/routes/model.js#handleAnswer` is a legacy no-op — it answered
// `{ok:true, deprecated:true}` without ever reaching the engine — so those
// buttons accepted a click and left the prompt pending. The endpoint now
// answers 410, the ask flow goes through `sendMessage({isAskAnswer:true})` and
// the authorization flow through `postAuthDecision`, both of which the engine
// actually receives. A plan decision has no webui-reachable channel at all;
// see the PlanModal comment in `components/modals.tsx` for the trace. Do not
// re-add a client here without a channel that reaches the engine.

// --- workspace --------------------------------------------------------------

export interface SetWorkspaceResult {
  ok: boolean;
  dir: string;
  branch: string | null;
  treeState?: string;
  workspace?: { dir: string; branch: string | null; tree: unknown };
  defaultWorkspace?: string;
  error?: string;
}

export const setWorkspace = (dir: string, syncTui = false) =>
  request<SetWorkspaceResult>("/api/workspace", {
    method: "POST",
    json: { dir, syncTui },
  });

export interface BrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/**
 * Server response from `GET /api/workspace/browse[?path=…]`.
 *
 * The server's wire field is **`dir`** — see
 * `packages/webui/server/lib/workspace.js#browseWorkspace`, which returns
 * `{ ok, dir, parent, children, roots, skipped, total }`. FilesPanel was
 * unaffected because its row reads are directory-name based; the workspace
 * picker in WorkspaceBrowseTab reads `dir` for the confirm/mkdir buttons,
 * so getting this wrong disables the picker (no confirm, silent mkdir).
 */
export interface BrowseResult {
  ok: boolean;
  /** The directory the server listed. Server wire field is `dir`. */
  dir: string | null;
  /** One level up; null when at a containment boundary. */
  parent: string | null;
  children: BrowseEntry[];
  skipped?: number;
  total?: number;
  /** POSIX root view lists allowed roots with `children: []` (see API.md). */
  roots?: string[];
  /** Server-reported home directory, surfaced alongside the root view. */
  home?: string;
  tmpDir?: string;
  platform?: string;
  error?: string;
}

/** List a directory for the workspace tree browser (containment-checked server-side).
 *
 * Reads `roots` from the error payload so the picker can render an
 * actionable "must be under: …" hint. `request()` throws on non-OK
 * responses and loses the rest of the payload, so this call goes
 * straight through `fetch` and parses the body — the route returns
 * the same `{ok:false, error, roots}` shape whether the status is
 * 200 or 400, and the picker UI treats them the same way.
 */
export async function browseWorkspace(
  path?: string,
): Promise<BrowseResult> {
  const url = withClientQuery(
    `/api/workspace/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`,
  );
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  let payload: BrowseResult;
  try {
    payload = text ? (JSON.parse(text) as BrowseResult) : { ok: false, error: "empty response", dir: null, parent: null, children: [] };
  } catch {
    payload = {
      ok: false,
      error: `HTTP ${response.status}`,
      dir: null,
      parent: null,
      children: [],
    };
  }
  return payload;
}

export interface RecentWorkspace {
  dir: string;
  name: string;
  lastActiveAt: number;
  sessionCount: number;
}

export interface RecentWorkspacesResult {
  ok: boolean;
  items: RecentWorkspace[];
  total: number;
  search: string;
  limit: number;
  tmpDir?: string;
}

/** Recents list — session-grouped and case-insensitive substring-filtered server-side. */
export const recentWorkspaces = (search = "", limit = 5) =>
  request<RecentWorkspacesResult>(
    `/api/workspace/recent?search=${encodeURIComponent(search)}&limit=${limit}`,
  );

export interface WorkspaceTreeWorkspace {
  dir: string;
  name: string;
  sessionCount: number;
  lastActiveAt: number;
  current: boolean;
  sessions: Array<{
    id: string;
    mcodeSessionId: string | null;
    title: string;
    updatedAt: number;
  }>;
}

export interface WorkspaceTreeResult {
  ok: boolean;
  current: string;
  defaultWorkspace: string;
  home: string;
  tmpDir: string;
  platform: string;
  workspaces: WorkspaceTreeWorkspace[];
}

/** Workspace → sessions tree (used by the picker's recents tab). */
export const workspaceTree = () =>
  request<WorkspaceTreeResult>("/api/workspace/tree");



// --- uploads ----------------------------------------------------------------

export interface UploadResult {
  ok: boolean;
  /** Absolute path of the stored file; the composer sends it as `@path`. */
  path: string;
  name: string;
  size: number;
}

/** Multipart upload (field name `file`); the server enforces size/quota limits. */
export function uploadFile(file: File): Promise<UploadResult> {
  const body = new FormData();
  body.append("file", file);
  return request<UploadResult>("/api/upload", { method: "POST", body });
}

// --- settings ---------------------------------------------------------------

export interface SettingsSnapshot {
  ok: boolean;
  lanBroadcast?: boolean;
  port?: number;
  host?: string;
  bindHost?: string;
  lanIp?: string;
  lanUrl?: string;
  lanUrlWithToken?: string;
  localUrl?: string;
  lanBind?: boolean;
  lanExposed?: boolean;
  bindRestartPending?: boolean;
  lanExposureNotice?: string;
  trustedOrigins?: string[];
  mcodeCmd?: string;
  mcodeVersion?: string;
  defaultWorkspace?: string;
  defaultModel?: string;
  readOnly?: boolean;
  tokenEnabled?: boolean;
  currentToken?: string;
  tokenAcknowledged?: boolean;
  tokenRotatedAt?: number;
}

export const getSettings = () => request<SettingsSnapshot>("/api/settings");

/**
 * Update settings. Any combination of the documented fields may be sent; the
 * server validates the whole batch before changing anything, so a rejected
 * `trustedOrigins` value cannot partially widen the CORS surface.
 */
export const postSettings = (patch: Record<string, unknown>) =>
  request<SettingsSnapshot & { changed?: boolean; tokenRotated?: boolean }>("/api/settings", {
    method: "POST",
    json: patch,
  });

// --- usage ------------------------------------------------------------------

/**
 * The plan-quota payload, served from the engine over ACP. `remaining` /
 * `weeklyRemaining` are percentages and are present only when the engine
 * reported a figure, so an `ok: true` body without them means "no gauge to
 * draw", not 0%. `resetAt` / `weeklyResetAt` are unix seconds.
 */
export interface QuotaSnapshot {
  ok: boolean;
  remaining?: number;
  weeklyRemaining?: number;
  resetAt?: number;
  weeklyResetAt?: number;
  fetchedAt?: number;
  source?: string;
  error?: string;
}

export interface TurnUsage {
  ok: boolean;
  lastTurnContextTokens?: number;
  contextLimit?: number;
  model?: string;
  ts?: number;
}

/**
 * The plan quota.
 *
 * POST, not GET: the route asks the engine over ACP and answers with the figures
 * it just read. A GET was never registered, so this call used to 404 and the
 * popover showed its error line no matter what the engine reported.
 *
 * `record` asks the server to also append this reading to the forecast history.
 * It is false by default — the poll that keeps the popover fresh is a reading,
 * not a measurement, and a sample every couple of minutes would grow that file
 * without bound for a forecast that only reads within the weekly window. Pass
 * true when the user deliberately asks for fresh figures.
 */
export const getQuota = (record = false) =>
  request<QuotaSnapshot>("/api/usage", { method: "POST", json: { record } });
export const getTurnUsage = () => request<TurnUsage>("/api/usage-real");
/** Re-fetch quota + per-turn context (the "refresh" affordance). */
export const refreshUsage = () => request<{ ok: boolean }>("/api/refresh", { method: "POST", json: {} });

// --- alerts -----------------------------------------------------------------

export interface AlertItem {
  id: string;
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
  src: string;
  cid: string | null;
  sessionId: string | null;
  count?: number;
}

// `/api/alerts` is Server-Sent Events, not JSON — it has no request/response
// form, so it is deliberately absent here. Subscribe through lib/alerts.ts.
// --- session search ---------------------------------------------------------

export interface SearchHit {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
  /** Deterministic 0-100 relevance, scored on title then id (see the route). */
  matchScore: number;
}

/** Session search; results are scored hits (see the route), not plain session rows. */
export const searchSessions = (q: string) =>
  request<{ ok: boolean; results: SearchHit[] }>(
    `/api/sessions/search?q=${encodeURIComponent(q)}`,
  );

// --- authorization ----------------------------------------------------------

/** Approve or deny a pending authorization request (`needs_authorization` frame). */
export const postAuthDecision = (requestId: string, approve: boolean) =>
  request<{ ok: boolean; approved?: boolean; decidedBy?: string }>("/api/auth/decision", {
    method: "POST",
    json: { requestId, approve },
  });

// --- filesystem -------------------------------------------------------------

/**
 * Create a directory. The server containment-checks the *parent* (the target does
 * not exist yet), so an out-of-root path is rejected with 403.
 */
export const mkdir = (path: string) =>
  request<{ ok: boolean; path?: string }>("/api/fs/mkdir", { method: "POST", json: { path } });

// --- file preview (slice 02) ----------------------------------------------
//
// The right-panel preview (`components/file-preview.tsx`) is a small
// type→renderer router over these two endpoints. The server returns text
// for `/api/fs/read-file` (≤512 KiB, with mime + language + binary flag so
// the UI can route without a second round-trip) and raw bytes for
// `/api/fs/raw` (≤20 MiB, mime mapped from extension). Both share the
// containment boundary of `/api/fs/read` — the parent agent's panels.tsx
// wiring is the only thing still TODO at this slice boundary.

export interface FsFilePayload {
  ok: boolean;
  path?: string;
  size?: number;
  /**
   * Slice 27 — the file's mtime (ms) at read time. The preview editor
   * records it together with `size` as the conflict-detection baseline
   * and sends it back on save; `/api/fs/write` answers 409 when the
   * disk has moved on in the meantime.
   */
  mtime?: number;
  /** Best-effort extension-based guess (markdown / typescript / …). */
  language?: string;
  /** Best-effort extension-based guess (image/png, text/markdown; charset=utf-8, …). */
  mime?: string;
  binary?: boolean;
  encoding?: "utf-8";
  content?: string;
  error?: string;
  /**
   * Slice 16 — structured server-side code (independent of HTTP
   * status). Today the webapp reads it to detect the credential
   * refusal (so the second confirmation can render); future codes
   * (e.g. "rate-limited") can land here without changing the status
   * mapping. The UI branches on this string, not on HTTP status.
   */
  code?:
    | "credential"
    | "out-of-bounds"
    | "binary"
    | "oversize"
    | "missing-path"
    | "not-a-regular-file"
    | string;
  /**
   * Slice 16 — credential sub-reason (`dotenv` / `key-file` /
   * `ssh-key` / `credentials` / `ssh-meta`). Populated only when
   * `code === "credential"`. The panel may use it to render a more
   * specific refusal message ("env file" vs "private key") without
   * branching on free-form text.
   */
  credentialReason?: "dotenv" | "key-file" | "ssh-key" | "credentials" | "ssh-meta";
}

/**
 * Read a single file's text content. The server's failure modes come back
 * here as `ok:false` with the same shape the server emitted — there is no
 * exception to catch, the preview component just branches on `ok`.
 */
export const getFsFile = async (
  path: string,
  opts: { confirmCredential?: boolean } = {},
): Promise<FsFilePayload> => {
  // The /api/fs/read-file endpoint answers 4xx with a JSON error body
  // that *also* carries mime / language / binary — the preview component
  // reads mime to route images through /api/fs/raw and language for the
  // code view's badge. The shared request() helper throws on non-OK
  // responses and would discard that body, so this caller uses raw fetch
  // and reads the JSON either way (it is always JSON — the route is
  // `application/json`).
  //
  // Slice 16 — `confirmCredential=1` opts into the second-confirmation
  // override for credential-shaped files. The server is still the real
  // gate (it requires the explicit flag to release the bytes); the webapp
  // sends the flag only after the user clicks "open anyway".
  const confirm = opts.confirmCredential ? "&confirm=1" : "";
  const response = await fetch(
    withClientQuery(
      `/api/fs/read-file?path=${encodeURIComponent(path)}${confirm}`,
    ),
    { headers: { Accept: "application/json" } },
  );
  const text = await response.text();
  let parsed: FsFilePayload | null = null;
  try {
    parsed = text ? (JSON.parse(text) as FsFilePayload) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new Error(response.ok ? "unexpected non-JSON response" : `HTTP ${response.status}`);
  }
  return parsed;
};

/**
 * Absolute URL for the raw bytes of a file (used as `<img src>` for
 * previews of images, fonts, etc.). The server attaches the right
 * `Content-Type` from the extension and caps at 20 MiB.
 */
export function fsRawUrl(path: string): string {
  return withClientQuery(
    `/api/fs/raw?path=${encodeURIComponent(path)}`,
  );
}

/**
 * Absolute URL that asks the same `/api/fs/raw` endpoint to attach
 * `Content-Disposition: attachment` so the browser saves the bytes
 * instead of rendering them. Slice 14 R207 — the third "下载查看"
 * action reuses the raw stream with a query flag rather than adding a
 * second streaming route, so the same containment gate + 20 MiB cap
 * stay in one place.
 *
 * Slice 16 — `opts.confirm === true` adds the explicit override
 * flag the credential gate (slice 16) requires before releasing the
 * bytes. The PreviewError download link calls this with
 * `confirm: true` when the classifier set `reason: "credential"`
 * — the user has clicked into a refusal and now clicks "download";
 * we propagate the explicit confirm so the server releases the
 * bytes rather than serving the JSON error body. Without this
 * flag the user would download the 403 error JSON, which is
 * confusing AND a security smell (the credential is still on disk;
 * we just gave them the gate's response instead of the file).
 */
export function fsRawDownloadUrl(
  path: string,
  opts: { confirm?: boolean } = {},
): string {
  const confirm = opts.confirm === true ? "&confirm=1" : "";
  return withClientQuery(
    `/api/fs/raw?path=${encodeURIComponent(path)}&download=1${confirm}`,
  );
}

// --- preview editor save (slice 27) --------------------------------------
//
// POST /api/fs/write is the preview toolbar's ONLY write path. The
// server re-runs the same containment gate as the read, refuses
// credential-shaped basenames without the explicit confirm flag, and
// conflict-checks the (mtime, size) baseline recorded when the file
// was opened — a stale baseline answers 409 and the disk file is
// untouched.

/** Structured result of `POST /api/fs/write`. `code` carries the
 *  failure vocabulary the toolbar branches on; the HTTP status is the
 *  conventional mapping (403 gate/credential, 404 gone, 409 conflict,
 *  413 over the write cap). */
export interface FsSaveResult {
  ok: boolean;
  code?:
    | "conflict"
    | "credential"
    | "not-found"
    | "not-a-regular-file"
    | "too-large"
    | "missing-path"
    | "missing-content"
    | "invalid-content"
    | "write-failed"
    | "BODY_TOO_LARGE"
    | string;
  error?: string;
  path?: string;
  /** Fresh baseline after a successful write (the next save's
   *  `expectedMtime` / `expectedSize`). */
  size?: number;
  mtime?: number;
  /** Live disk baseline on a 409 — the conflict card shows when the
   *  external edit landed. */
  diskMtime?: number;
  diskSize?: number;
  credentialReason?: string;
}

/**
 * Save the editor buffer back to the workspace file.
 *
 * - `expectedMtime` / `expectedSize`: the baseline from the load that
 *   seeded the editor. Send both; a save WITHOUT them is an explicit
 *   overwrite (the panel only does that after the user answered the
 *   conflict card).
 * - `confirmCredential`: the slice-16 override flag. Send only after
 *   the user passed the credential confirmation card.
 *
 * Like `getFsFile`, this goes through raw fetch — the 4xx bodies carry
 * structured `code` fields the toolbar needs, which the throwing
 * `request()` helper would discard.
 */
export async function saveFsFile(
  path: string,
  content: string,
  opts: {
    expectedMtime?: number;
    expectedSize?: number;
    confirmCredential?: boolean;
  } = {},
): Promise<FsSaveResult> {
  const body: Record<string, unknown> = { path, content };
  if (opts.expectedMtime !== undefined) body.expectedMtime = opts.expectedMtime;
  if (opts.expectedSize !== undefined) body.expectedSize = opts.expectedSize;

  if (opts.confirmCredential) body.confirm = true;
  const response = await fetch(withClientQuery("/api/fs/write"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: FsSaveResult | null = null;
  try {
    parsed = text ? (JSON.parse(text) as FsSaveResult) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      code: "write-failed",
      error: response.ok ? "unexpected non-JSON response" : `HTTP ${response.status}`,
    };
  }
  return parsed;
}

// --- file-open actions (slice 14) ----------------------------------------
//
// The two endpoints below turn the right-hand preview panel from a dead
// end into an actionable surface for files the in-product preview cannot
// render (binary blobs, oversized payloads, MIME-mapped but unsupported
// formats). The server already returns a structured `code` so the UI
// can branch on the failure mode without parsing free-form text.
//
// `request()` throws on non-OK responses and would lose the `code`
// field, so these two callers go straight through `fetch` and parse
// the JSON either way — same shape as `getFsFile` above.

export type FileOpenCode =
  | "missing-path"
  | "out-of-bounds"
  | "not-a-regular-file"
  | "no-opener"
  | "spawn-failed"
  | "BODY_TOO_LARGE";

export interface FileOpenResult {
  ok: boolean;
  /** Structured rejection code (only present when `ok === false`). */
  code?: FileOpenCode;
  /** Human-readable error message — surfacing hint for the UI banner. */
  error?: string;
}

/**
 * POST /api/fs/open-default — hand a path to the OS default application.
 *
 * Server-side containment + per-node realpath gating is shared with the
 * other /api/fs/* routes (see server/lib/open-target.js). The function
 * resolves with a `FileOpenResult` regardless of HTTP status; the caller
 * branches on `result.code` to decide whether to disable the button
 * (no-opener), show an inline error (spawn-failed), or surface the
 * containment refusal (out-of-bounds / not-a-regular-file).
 */
export async function openFileWithDefault(path: string): Promise<FileOpenResult> {
  const response = await fetch(withClientQuery("/api/fs/open-default"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ path }),
  });
  return parseFileOpenResponse(response);
}

/**
 * POST /api/fs/reveal — open the file manager pointed at the path.
 *
 * macOS / Windows select the row in the file manager; Linux opens the
 * parent directory (no portable "select" command on the freedesktop
 * side). Same wire shape and error-code vocabulary as
 * `openFileWithDefault`.
 */
export async function revealInFileManager(path: string): Promise<FileOpenResult> {
  const response = await fetch(withClientQuery("/api/fs/reveal"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ path }),
  });
  return parseFileOpenResponse(response);
}

async function parseFileOpenResponse(response: Response): Promise<FileOpenResult> {
  const text = await response.text();
  let parsed: FileOpenResult | null = null;
  try {
    parsed = text ? (JSON.parse(text) as FileOpenResult) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      code: "spawn-failed",
      error: response.ok ? "unexpected non-JSON response" : `HTTP ${response.status}`,
    };
  }
  return parsed;
}

/** Absolute URL for a session export; `download` makes the browser save it. */
export function sessionExportUrl(id: string, format: "md" | "json" = "md"): string {
  return withClientQuery(
    `/api/sessions/${encodeURIComponent(id)}/export?format=${format}&download=true`,
  );
}

// --- git panel (slice 03) -------------------------------------------------

/**
 * Wire shape returned by `GET /api/git/status`. `isRepo:false` is the
 * normal answer for a non-git directory — the panel renders an empty
 * state rather than a red toast, so the helper does NOT throw on it.
 */
export interface GitStatusFile {
  /** Porcelain index status (e.g. "M", "A", "?", " " when only the worktree differs). */
  x: string;
  /** Porcelain worktree status (e.g. "M", "?", " " when only the index differs). */
  y: string;
  /** Path relative to the workspace root, as `git status --porcelain` emits it. */
  path: string;
  /** Pre-rename path for rename entries; `null` otherwise. */
  origPath: string | null;
  /** True when the index side carries a change (`x !== ' ' && x !== '?'`). */
  staged: boolean;
}

export interface GitStatusPayload {
  ok: boolean;
  /** `false` when the directory is not inside a git working tree. */
  isRepo?: boolean;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  /**
   * Abbreviated commit id of HEAD, at git's own abbreviation length
   * (7 by default, longer in a repository where 7 would be
   * ambiguous). `null` for a repository with no commits yet — the
   * conversation toolbar's version badge renders nothing in that case.
   */
  headSha?: string | null;
  /**
   * HEAD's **committer** time as a strict ISO 8601 string. Committer
   * time rather than author time because the question this answers is
   * "when did this content enter this tree" — a rebase, amend or
   * cherry-pick moves the committer time forward while the author
   * time stays at the original write. `null` alongside `headSha`.
   */
  headCommittedAt?: string | null;
  files?: GitStatusFile[];
  error?: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitBranchesPayload {
  ok: boolean;
  branches?: GitBranch[];
  error?: string;
}

export interface GitDiffPayload {
  ok: boolean;
  diff?: string;
  error?: string;
}

export interface GitCheckoutPayload {
  ok: boolean;
  error?: string;
}

/**
 * Workspace status — read by the right-panel Git panel and (via the
 * same server helper) by the `/review` slash command. `dir` is the
 * `state.workspace.dir` value; the server gates containment, so an
 * out-of-root `dir` answers `{ok:false, isRepo:false}`.
 */
export function getGitStatus(dir: string): Promise<GitStatusPayload> {
  return request<GitStatusPayload>(
    `/api/git/status?dir=${encodeURIComponent(dir)}`,
  );
}

export function getGitBranches(dir: string): Promise<GitBranchesPayload> {
  return request<GitBranchesPayload>(
    `/api/git/branches?dir=${encodeURIComponent(dir)}`,
  );
}

export function getGitDiff(dir: string, file: string): Promise<GitDiffPayload> {
  return request<GitDiffPayload>(
    `/api/git/diff?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`,
  );
}

/**
 * Destructive — the panel must gate this behind a confirmation prompt.
 * The branch name is allow-list gated on the server, so a forged
 * request cannot smuggle an option through (see `server/lib/git.js`).
 */
export function gitCheckout(dir: string, branch: string): Promise<GitCheckoutPayload> {
  return request<GitCheckoutPayload>("/api/git/checkout", {
    method: "POST",
    json: { dir, branch },
  });
}

// --- plugins (ticket 60, dispatch 68 phase 1) -------------------------------

/**
 * Plugin source as the browser branches on it.
 *
 * The runtime enum `InstalledPluginSource` is numeric (1 = official,
 * 2 = local). `@mavis/webui` deliberately does not depend on
 * `@mavis/protocol` — the webapp has no such dependency and must not
 * grow one — so `server/routes/plugins.js` stamps a protocol-free
 * `sourceKind` string on every plugin element and on every mutation
 * answer, and `webapp` restates the literals. Requests travel the
 * other way in the numeric form (`?source=2`, `{"source":2}`),
 * matching the reference contract in
 * `plugin-management.ts#INPUT_SHAPES`; `PLUGIN_SOURCE_WIRE_VALUE`
 * below is the single conversion point.
 */
export type PluginSource = "official" | "local";

/**
 * What the route stamps. `unknown` is its defensive fallback for an
 * element whose `source` is neither 1 nor 2; nothing should render a
 * marketplace card for it.
 */
export type PluginSourceKind = PluginSource | "unknown";

const PLUGIN_SOURCE_WIRE_VALUE: Record<PluginSource, 1 | 2> = {
  official: 1,
  local: 2,
};

/**
 * Marketplace category id. The runtime's `MarketplaceCategory` is a
 * numeric enum (0 = other … 10 = education) and the route reads the
 * category off the query string as a plain integer, so webapp restates
 * the ids instead of importing the protocol package.
 */
export type PluginCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Capability counts carried by every plugin summary. */
export interface PluginCapabilityCounts {
  appCount: number;
  mcpServerCount: number;
  skillCount: number;
  hookCount?: number;
}

export interface InstalledPlugin {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  darkIconUrl?: string;
  /** Which side of the marketplace this plugin lives on. */
  sourceKind: PluginSourceKind;
  /** The raw runtime enum (1 / 2); `sourceKind` is the form to read. */
  source?: number;
  enabled: boolean;
  capabilities: PluginCapabilityCounts;
}

export interface MarketplacePlugin {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  darkIconUrl?: string;
  /**
   * Stamped by the route from the requested source — a marketplace
   * summary carries no source of its own, because the page *is* one
   * source. The plugin summary inside an import answer is the raw
   * runtime shape, so this stays optional.
   */
  sourceKind?: PluginSourceKind;
  source?: number;
  installExists: boolean;
  enabled: boolean;
  category?: PluginCategory;
  capabilities: PluginCapabilityCounts;
}

/**
 * A standalone skill as the local marketplace projects it. It arrives
 * beside the plugin rows, not inside them: the local branch merges two
 * sources (local packages + standalone skills) and the caller decides
 * whether to interleave them.
 */
export interface MarketplaceSkill {
  id: number;
  name: string;
  displayName?: string;
  description?: string;
  displayDescription?: string;
  category?: PluginCategory;
  /** True when the skill is already present locally. */
  added?: boolean;
}

export interface EnabledPlugin {
  name: string;
  displayName?: string;
  iconUrl?: string;
  darkIconUrl?: string;
}

/**
 * Shared failure fields. A runtime rejection answers HTTP 200 with
 * `ok:false` plus a machine-readable `code`
 * (`PLUGIN_NOT_FOUND`, `PLUGIN_AUTH_REQUIRED`, `PLUGIN_ALREADY_EXISTS`,
 * `RUNTIME_UNAVAILABLE`, …), so the caller branches on `code` rather
 * than on the message.
 *
 * A rejected *request* is an HTTP error and throws instead — 400
 * `invalidBody` for a malformed parameter, 400 with the code intact for
 * the three facade validation codes (`INVALID_PLUGIN_SOURCE`,
 * `PLUGIN_LIMIT_INVALID`, `PLUGIN_CURSOR_INVALID`), 403 in read-only
 * mode, 413 above 1 MiB. `request` surfaces a non-2xx as an `Error`
 * carrying the server's `error` text, so a caller that needs to act on
 * one of those codes resets its cursor on filter change rather than
 * parsing the failure — the same rule every other helper here follows.
 */
interface PluginApiFailure {
  error?: string;
  code?: string;
}

export interface PluginsInstalledPayload extends PluginApiFailure {
  ok: boolean;
  plugins?: InstalledPlugin[];
  hasMore?: boolean;
  nextCursor?: string;
}

export interface PluginsMarketplacePayload extends PluginApiFailure {
  ok: boolean;
  /** The source this page was requested for. */
  source?: number;
  sourceKind?: PluginSourceKind;
  plugins?: MarketplacePlugin[];
  hasMore?: boolean;
  nextCursor?: string;
  /** Rows matching the filter before paging. */
  pluginTotal?: number;
  /**
   * The registry answered with a cursor that no longer fits the query;
   * drop the cursor and start the list again. Only the official branch
   * can raise it.
   */
  cursorResetRequired?: boolean;
  /** Local source only — see `MarketplaceSkill`. */
  marketplaceSkills?: MarketplaceSkill[];
  skillHasMore?: boolean;
  skillNextCursor?: string;
}

export interface PluginsEnabledPayload extends PluginApiFailure {
  ok: boolean;
  plugins?: EnabledPlugin[];
}

/** The refresh answer carries no data — the caller re-pulls the list. */
export interface PluginsRefreshPayload extends PluginApiFailure {
  ok: boolean;
}

export interface PluginMutationPayload extends PluginApiFailure {
  ok: boolean;
  sourceKind?: PluginSourceKind;
  source?: number;
  /** False when the target is not installed — the uninstall answer. */
  installExists?: boolean;
  enabled?: boolean;
}

/** Pinned repository coordinates; the preview echoes them back. */
export interface GithubPluginSource {
  repositoryUrl: string;
  commitSha: string;
  subPath?: string;
}

export interface PluginImportDiagnostic {
  code: string;
  capability?: string;
  name?: string;
}

export interface PluginImportPreviewPayload extends PluginApiFailure {
  ok: boolean;
  source?: GithubPluginSource;
  plugin?: {
    summary: MarketplacePlugin;
    skillCount: number;
    mcpServerCount: number;
    hasStdioMcp: boolean;
  };
  diagnostics?: PluginImportDiagnostic[];
  packageSizeBytes?: number;
  /** False when the package exposes nothing this runtime can use. */
  canImport?: boolean;
}

export interface PluginImportPayload extends PluginApiFailure {
  ok: boolean;
  plugin?: MarketplacePlugin;
}

export interface PluginListQuery {
  keyword?: string;
  /** Page size. The route caps it at 200 and defaults to 50. */
  limit?: number;
  /**
   * Opaque forward cursor. It is bound to the `keyword` it was issued
   * for — reusing it after a keyword change answers
   * `PLUGIN_CURSOR_INVALID`, so reset it whenever the filter changes.
   */
  cursor?: string;
}

export interface PluginMarketplaceQuery extends PluginListQuery {
  /**
   * Required. The runtime reads a missing source as "official", which
   * points a default request at a cloud registry the local edition
   * cannot reach, so the route rejects the omission instead.
   */
  source: PluginSource;
  category?: PluginCategory;
  skillLimit?: number;
  skillCursor?: string;
}

// Lists answer from a local runtime call, but the official branch waits
// on a cloud registry first; 30 s is generous for the local path and
// still short enough to fail visibly on a dead one.
const PLUGINS_READ_TIMEOUT_MS = 30_000;
// Mutations reconcile against the registry and may wait for an auth
// sync to settle, so they get a longer deadline than a read.
const PLUGINS_MUTATION_TIMEOUT_MS = 60_000;
// Import fetches a public GitHub archive and unpacks it.
const PLUGINS_IMPORT_TIMEOUT_MS = 60_000;

function pluginsQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Installed plugins, official and local segments merged, one page.
 * Each element carries the `sourceKind` string the panel branches on.
 *
 * `GET /api/plugins/installed` — func_name `plugins.list.installed`.
 * Refresh with `refreshPlugins()` and pull this again; the panels read
 * `ok` and, on `ok:false`, `code`.
 */
export function listInstalledPlugins(
  params: PluginListQuery = {},
): Promise<PluginsInstalledPayload> {
  const query = pluginsQuery({
    keyword: params.keyword,
    limit: params.limit,
    cursor: params.cursor,
  });
  return request<PluginsInstalledPayload>(
    `/api/plugins/installed${query ? `?${query}` : ""}`,
    { timeoutMs: PLUGINS_READ_TIMEOUT_MS },
  );
}

/**
 * Marketplace rows for one source. `source` is required and leaves as
 * the numeric enum; the answer echoes it back and stamps `sourceKind`
 * on the page and on every row.
 *
 * `GET /api/plugins/marketplace` — func_name `plugins.list.marketplace`.
 * `source:"local"` is real data (standalone skills plus the local
 * package projection). `source:"official"` is the one honest placeholder
 * of phase 1: the cloud base URL does not resolve in the local edition,
 * so the call answers `ok:false` and the caller renders the
 * `plugins.market.official.notLocal.*` copy instead of an error.
 */
export function listMarketplacePlugins(
  params: PluginMarketplaceQuery,
): Promise<PluginsMarketplacePayload> {
  const { source, ...rest } = params;
  const query = pluginsQuery({
    keyword: rest.keyword,
    limit: rest.limit,
    cursor: rest.cursor,
    category: rest.category,
    skillLimit: rest.skillLimit,
    skillCursor: rest.skillCursor,
    source: PLUGIN_SOURCE_WIRE_VALUE[source],
  });
  return request<PluginsMarketplacePayload>(`/api/plugins/marketplace?${query}`, {
    timeoutMs: PLUGINS_READ_TIMEOUT_MS,
  });
}

/**
 * The plugins the current turn can actually use — the runtime's own
 * enabled snapshot rather than the installed list.
 *
 * `GET /api/plugins/enabled` — func_name `plugins.list.enabled`.
 */
export function listEnabledPlugins(): Promise<PluginsEnabledPayload> {
  return request<PluginsEnabledPayload>("/api/plugins/enabled", {
    timeoutMs: PLUGINS_READ_TIMEOUT_MS,
  });
}

/**
 * Reconcile installed state against both sources.
 *
 * `POST /api/plugins/refresh` — func_name `plugins.refresh.all`. Takes
 * no body; the answer carries no data, so the caller reloads
 * `listInstalledPlugins` afterwards.
 */
export function refreshPlugins(): Promise<PluginsRefreshPayload> {
  return request<PluginsRefreshPayload>("/api/plugins/refresh", {
    method: "POST",
    json: {},
    timeoutMs: PLUGINS_MUTATION_TIMEOUT_MS,
  });
}

/**
 * Turn a plugin on.
 *
 * `POST /api/plugins/enable` — func_name `plugins.enable.by_name`.
 * `installExists` says whether the target is on disk, `enabled` is the
 * resulting state. A rejection answers 200 with `PLUGIN_NOT_FOUND`,
 * `PLUGIN_AUTH_REQUIRED` or `PLUGIN_AUTH_SYNC_TIMEOUT`; a body the
 * runtime will not read answers 400 `invalidBody`.
 */
export function enablePlugin(
  pluginName: string,
  source?: PluginSource,
): Promise<PluginMutationPayload> {
  return request<PluginMutationPayload>("/api/plugins/enable", {
    method: "POST",
    json: pluginMutationBody(pluginName, source),
    timeoutMs: PLUGINS_MUTATION_TIMEOUT_MS,
  });
}

/**
 * Turn a plugin off. Disabling deactivates its turn hooks, so a session
 * already running on that plugin keeps its own progress.
 *
 * `POST /api/plugins/disable` — func_name `plugins.disable.by_name`.
 */
export function disablePlugin(
  pluginName: string,
  source?: PluginSource,
): Promise<PluginMutationPayload> {
  return request<PluginMutationPayload>("/api/plugins/disable", {
    method: "POST",
    json: pluginMutationBody(pluginName, source),
    timeoutMs: PLUGINS_MUTATION_TIMEOUT_MS,
  });
}

/**
 * Install a plugin.
 *
 * `POST /api/plugins/install` — func_name `plugins.install.by_name`.
 * Only the official source installs in the local edition; a local
 * package answers `LOCAL_PLUGIN_INSTALL_UNSUPPORTED`, which is product
 * semantics rather than a fault, so the local card renders no install
 * button in the first place.
 */
export function installPlugin(
  pluginName: string,
  source?: PluginSource,
): Promise<PluginMutationPayload> {
  return request<PluginMutationPayload>("/api/plugins/install", {
    method: "POST",
    json: pluginMutationBody(pluginName, source),
    timeoutMs: PLUGINS_MUTATION_TIMEOUT_MS,
  });
}

/**
 * Uninstall a plugin. **Destructive** — the panel must gate this behind
 * a confirmation prompt.
 *
 * `POST /api/plugins/uninstall` — func_name `plugins.uninstall.by_name`.
 * A target that is not installed answers `ok:true` with
 * `installExists:false`: the call is idempotent, not an error.
 */
export function uninstallPlugin(
  pluginName: string,
  source?: PluginSource,
): Promise<PluginMutationPayload> {
  return request<PluginMutationPayload>("/api/plugins/uninstall", {
    method: "POST",
    json: pluginMutationBody(pluginName, source),
    timeoutMs: PLUGINS_MUTATION_TIMEOUT_MS,
  });
}

/**
 * Read a GitHub repository URL and report what importing it would bring
 * in — the dry run behind the import dialog, and it reaches the public
 * internet directly rather than the official registry.
 *
 * `POST /api/plugins/import/preview` — func_name
 * `plugins.import.preview_url`. A refusal is an invalid URL,
 * `PLUGIN_NO_SUPPORTED_CAPABILITY`, or a network failure; `canImport`
 * is false when the package exposes nothing this runtime can run.
 */
export function previewGithubPlugin(url: string): Promise<PluginImportPreviewPayload> {
  return request<PluginImportPreviewPayload>("/api/plugins/import/preview", {
    method: "POST",
    json: { url },
    timeoutMs: PLUGINS_IMPORT_TIMEOUT_MS,
  });
}

/**
 * Install the plugin the preview resolved. The answer carries the
 * plugin summary, enabled.
 *
 * `POST /api/plugins/import` — func_name `plugins.import.from_url`.
 * A rejection is `PLUGIN_ALREADY_EXISTS` or `PLUGIN_IMPORT_INVALID`.
 */
export function importGithubPlugin(
  source: GithubPluginSource,
): Promise<PluginImportPayload> {
  return request<PluginImportPayload>("/api/plugins/import", {
    method: "POST",
    json: { source },
    timeoutMs: PLUGINS_IMPORT_TIMEOUT_MS,
  });
}

/**
 * The four mutators share one body: a required name plus the source the
 * caller is acting on. An omitted source is forwarded as-is, and the
 * runtime reads a missing one as "official" one layer down — so a
 * caller that knows which side the plugin came from always passes it.
 */
function pluginMutationBody(
  pluginName: string,
  source?: PluginSource,
): { pluginName: string; source?: 1 | 2 } {
  return source === undefined
    ? { pluginName }
    : { pluginName, source: PLUGIN_SOURCE_WIRE_VALUE[source] };
}


// --- per-turn file changes (webui-parity 83) -------------------------------
//
// The turn coordinate is `assistantMessageId` — the msg_id the engine
// persisted the turn's record under. It is REQUIRED on all three calls, and
// the route answers an empty record without touching the engine when it is
// missing: the engine's own selector falls back to the session's LATEST turn,
// which would show another turn's counts and let an undo rewrite that turn's
// files instead. Callers must pass the id they got from the transcript.

/** The engine's turn-diff view, narrowed to the fields the card reads. */
export interface TurnDiffPayload {
  readonly fileChanges?: {
    readonly file: string;
    readonly additions: number;
    readonly deletions: number;
    readonly status?: string;
  }[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly status?: string;
  readonly undoable?: boolean;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
}

export interface TurnDiffResult {
  readonly ok: boolean;
  /** `null` means "no record for this coordinate" — never a default turn. */
  readonly turnDiff: TurnDiffPayload | null;
}

// A revert rewrites workspace files and the engine verifies each against its
// captured snapshot, so it is slower than a read but never unbounded.
const TURN_DIFF_MUTATION_TIMEOUT_MS = 60_000;

export function getTurnDiff(
  sessionId: string,
  assistantMessageId: string,
): Promise<TurnDiffResult> {
  const search = new URLSearchParams({ sessionId, assistantMessageId });
  return request<TurnDiffResult>(`/api/turn-diff?${search.toString()}`);
}

export function revertTurnDiff(
  sessionId: string,
  assistantMessageId: string,
): Promise<TurnDiffResult> {
  return request<TurnDiffResult>("/api/turn-diff/revert", {
    method: "POST",
    json: { sessionId, assistantMessageId },
    timeoutMs: TURN_DIFF_MUTATION_TIMEOUT_MS,
  });
}

export function reapplyTurnDiff(
  sessionId: string,
  assistantMessageId: string,
): Promise<TurnDiffResult> {
  return request<TurnDiffResult>("/api/turn-diff/reapply", {
    method: "POST",
    json: { sessionId, assistantMessageId },
    timeoutMs: TURN_DIFF_MUTATION_TIMEOUT_MS,
  });
}

// --- worktrees (PB-3) -------------------------------------------------------

/**
 * One row of `GET /api/worktrees`, exactly as the engine's
 * `WorkspaceGitWorktree` (packages/local-runtime/src/files/worktrees.ts:11-20)
 * spells it. Nothing is renamed and nothing is defaulted, because the page's
 * three time tabs and its 「当前」 marker both read these flags directly and a
 * renamed field would be a second definition of the same fact.
 */
export interface WorktreeRow {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Branch name with the `refs/heads/` prefix already stripped by the engine. */
  branch: string;
  /** Commit sha the worktree is parked on; empty for a detached head. */
  head: string;
  /** The repository's primary checkout — the engine refuses to remove it. */
  isMain: boolean;
  /** `git worktree lock` was applied; the engine refuses to remove it. */
  isLocked: boolean;
  /** This is the workspace the current conversation is running in. */
  isActive: boolean;
  /** Lives under the repository's own `.worktrees/` directory. */
  isMcodeManaged: boolean;
  /**
   * Last modification, in epoch milliseconds.
   *
   * `undefined` is a REAL reading, not a missing field: the engine falls back
   * from the directory mtime to the last reflog entry and can reach neither.
   * The page shows such a row in every time tab and labels it 「时间未知」 —
   * filing it at 0 would hide a fresh worktree from the default tab.
   */
  lastModifiedMs?: number;
}

/**
 * The engine's closed removal-reason set
 * (packages/local-runtime/src/files/managed-worktrees.ts:7-13). It is a union
 * rather than `string` so that adding a reason upstream fails the page's
 * reason table at compile time instead of shipping a raw token into the UI.
 */
export type WorktreeRemovalReason =
  | "main_worktree"
  | "active_worktree"
  | "not_found"
  | "locked_worktree"
  | "dirty_worktree"
  | "unknown";

/** One refused item of a batch removal, with the engine's own reason. */
export interface WorktreeRemovalFailure {
  worktreeDir: string;
  reason: WorktreeRemovalReason;
  error?: string;
}

/**
 * `GET /api/worktrees` — the 工作树 page's list.
 *
 * `ok: false` is a REPORT, not a transport failure: the engine answered and
 * said the directory is not a Git repository (`code: "not_git_repository"`),
 * could not be reached, or could not be listed. A page that turned that into
 * an empty list would tell the user they have nothing to clean up.
 */
export interface WorktreeListPayload {
  ok: boolean;
  workspace: string;
  /** The repository's primary checkout path, when the engine reported one. */
  current?: string;
  worktrees: WorktreeRow[];
  /** Engine discovery code: `not_git_repository` / `workspace_unavailable` / `worktree_list_failed`. */
  code?: string;
  error?: string;
}

/**
 * `POST /api/worktrees/remove` — the page's 一键移除.
 *
 * `ok: true` means the REQUEST was carried out, not that something was
 * deleted: a selection where every item was refused comes back as
 * `ok: true` with a full `failedItems` list. Each failure carries the
 * engine's own reason, which is what the page turns into a sentence.
 */
export interface WorktreeRemovalPayload {
  ok: boolean;
  removedPaths: string[];
  failedItems: WorktreeRemovalFailure[];
}

/**
 * List one repository's worktrees.
 *
 * `workspace` is optional: without it the server uses the current
 * conversation's workspace, so the page can open with a bare GET. A browser
 * outside any conversation sends the path it was given.
 */
export const getWorktrees = (workspace?: string) =>
  request<WorktreeListPayload>(
    workspace === undefined || workspace === ""
      ? "/api/worktrees"
      : `/api/worktrees?workspace=${encodeURIComponent(workspace)}`,
  );

/** Remove a selection of worktrees. The engine decides each item's fate. */
export const removeWorktrees = (
  items: Array<{ workspace: string; worktreeDir: string }>,
  activeWorktreeDir?: string,
) =>
  request<WorktreeRemovalPayload>("/api/worktrees/remove", {
    method: "POST",
    json: {
      items,
      ...(activeWorktreeDir === undefined ? {} : { activeWorktreeDir }),
    },
  });
