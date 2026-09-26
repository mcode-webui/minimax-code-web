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

export const switchSession = (id: string) =>
  request<{ ok: boolean }>("/api/sessions/switch", { method: "POST", json: { id } });

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
 */
export interface ModelEntry {
  id: string;
  name?: string;
  label?: string;
  provider?: string;
  source?: "engine" | "config" | "builtin";
  contextLimit?: number;
}

export interface ModelGroup {
  id: string;
  label: string;
  models: ModelEntry[];
}

export interface ModelsPayload {
  ok: boolean;
  /** `id` of the active model, or `null`/`DEFAULT_MODEL` fallback when none recorded. */
  current: string;
  models: ModelEntry[];
  /** Per-provider groups; same models appear in `models[]` flat too. */
  groups: ModelGroup[];
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

export const setModel = (model: string) =>
  request<{ ok: boolean }>("/api/set-model", { method: "POST", json: { model } });

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

/** Absolute URL for a session export; `download` makes the browser save it. */
export function sessionExportUrl(id: string, format: "md" | "json" = "md"): string {
  return withClientQuery(
    `/api/sessions/${encodeURIComponent(id)}/export?format=${format}&download=true`,
  );
}

