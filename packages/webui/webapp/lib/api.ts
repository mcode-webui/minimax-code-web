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
      throw new Error(`no response within ${timeoutMs}ms`);
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
    throw new Error(message);
  }
  return payload as T;
}

// --- state and health -------------------------------------------------------

export const getState = () => request<WebuiState>("/api/state");

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

// Both send endpoints answer with an ack *before* the engine runs (see
// routes/chat.js#handleSend), so a reply slower than this means the request is
// not going to arrive at all.
const SEND_ACK_TIMEOUT_MS = 30_000;

export const sendMessage = (payload: SendPayload) =>
  request<{ ok: boolean }>("/api/send", {
    method: "POST",
    json: payload,
    timeoutMs: SEND_ACK_TIMEOUT_MS,
  });

export const stopRun = () => request<{ ok: boolean }>("/api/stop", { method: "POST", json: {} });

/** Raw slash command (e.g. `/compact`), forwarded to mcode. */
export const sendCommand = (cmd: string) =>
  request<{ ok: boolean }>("/api/cmd", {
    method: "POST",
    json: { cmd },
    timeoutMs: SEND_ACK_TIMEOUT_MS,
  });

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
  auth: { type: ProviderAuthType; apiKey: string; baseURL?: string };
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

/**
 * The account card's data, from the engine's `mcode/account/status` method.
 *
 * Display fields and quota figures only: the engine's projection carries no
 * credential and omits the account email on purpose. Fetched on demand rather
 * than carried in the state snapshot, which is broadcast to every SSE
 * subscriber.
 */
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

/**
 * Answer a pending permission prompt or plan review.
 * `type: "permission"` answers a tool-approval prompt; the ask_user flow uses
 * `POST /api/send` with `isAskAnswer` instead.
 */
export const answer = (type: string, option: string) =>
  request<{ ok: boolean }>("/api/answer", { method: "POST", json: { type, option } });

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

