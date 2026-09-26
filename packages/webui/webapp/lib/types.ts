/**
 * Shapes of the webui server's state snapshot.
 *
 * These mirror `server/lib/state-bus.js` (the `state` object it broadcasts over
 * SSE and returns from `GET /api/state`). Only the fields the frontend actually
 * consumes are typed; the snapshot carries more, and an unlisted field is not a
 * reason to fail — see `lib/store.tsx`, which passes unknown fields through
 * untouched.
 *
 * Keep in sync with server/lib/state-bus.js.
 */

export type ThemeName = "light" | "dark";

export interface WorkspaceState {
  dir: string;
  branch: string | null;
  tree: unknown;
}

export interface ModelState {
  name: string;
  /** Recorded pre-session thinking-effort level (`low` / `medium` /
   *  `high` / `off`), or `""` when the user has not picked one and the
   *  engine's default stands. Populated by `handleSetModel` and by
   *  the engine's `config_option_update` notification
   *  (`applyConfigOptionUpdate` in lib/mcode-acp.js). */
  thinking: string;
  ctx: string;
}

export interface ContextState {
  tokens: number;
  used: number;
  percent: number;
  limit: number;
  tps: number;
  thinkingStatus: string;
  thinkingDuration: number | null;
  lastUsageAt: number | null;
  // SPEC §E row 138–140 — per-category composition of the context window.
  // The server may omit this; the panel falls back to a single progress bar
  // when it is `null` or empty.
  breakdown?: Record<string, number> | null;
  // SPEC §E row 141 — plan usage section. `title` is the active tier name;
  // `rows` are the labelled KPI rows rendered below the breakdown.
  plan?: ContextPlanSection | null;
}

export interface ContextPlanSection {
  title?: string | null;
  rows: ContextPlanRow[];
}

export interface ContextPlanRow {
  label?: string;
  value?: string;
}

/**
 * Plan-level quota, refreshed from the engine over ACP (`server/lib/usage.js`).
 * `fiveHourPercent` / `weekly` are the remaining figures, `*Reset` are the
 * window's next reset as unix seconds, and `hidden` is the engine's own verdict
 * that it has no quota reading — a not-subscribed or unreachable account.
 */
export interface UsageState {
  plan: string | null;
  planExpiresAtMs: number | null;
  creditBalance: string | null;
  fiveHourPercent: number | null;
  fiveHourReset: number | null;
  weekly: string | null;
  weeklyReset: number | null;
  sessionInput: number;
  sessionOutput: number;
  sessionTotal: number;
  raw: unknown;
  fetchedAt: number | null;
  error: string | null;
  hidden?: boolean;
}

export interface GoalState {
  active: boolean;
  text: string | null;
  status: string | null;
  duration: number | null;
}

export interface AskState {
  active: boolean;
  total: number;
  answered: number;
  currentIdx: number;
  question: string;
  options: string[];
  /**
   * Engine-supplied multi-select flag for the active ask question.
   * Optional — AskModal reads it defensively with `=== true`, so undefined
   * falls through to single-select, the safe default.
   */
  multiSelect?: boolean;
}

export interface PlanState {
  active: boolean;
  title: string | null;
  summary: string;
  options: string[];
}

export interface RunningState {
  active: boolean;
  prompt: string | null;
  pid: number | null;
  startedAt: number | null;
  model: string | null;
  sessionId: string | null;
  lastDeltaAt: number | null;
}

export interface SessionSummary {
  id: string;
  title?: string;
  updatedAt?: number;
  [key: string]: unknown;
}

/**
 * A single line of the server-side transcript.
 *
 * The server encodes speaker and state as a leading glyph on each line — `›` user,
 * `●` assistant, `○` system — with a trailing ` ▍` marking the streaming cursor.
 * `lib/transcript.ts` decodes that; nothing above it should inspect the glyphs.
 */
export type TranscriptLine = string;

export interface WebuiState {
  version: string;
  workspace: WorkspaceState;
  model: ModelState;
  sessionId: string | null;
  mcodeSessionId: string | null;
  sessionTitle: string;
  lastUsedWorkspace: string | null;
  context: ContextState;
  usage: UsageState;
  permissions: string;
  /** Raw server transcript lines — decode with `lib/transcript.ts`. */
  chat: TranscriptLine[];
  sessions: SessionSummary[];
  goal: GoalState;
  todo: unknown[];
  ask: AskState;
  plan: PlanState;
  running: RunningState;
  /**
   * Slash-command catalogue reported by mcode over ACP. The server's wire shape
   * is a dict of command groups, e.g. `{ mcode: [{ name, description }, ...] }`,
   * which the composer flattens into a `string[]` of `name` values before
   * showing it as a completion palette.
   */
  availableCommands: Record<string, Array<{ name: string; description?: string }>>;
  /** Only present on the per-client snapshots, not on `GET /api/state`. */
  onlineCount?: number;
  lanBroadcast: boolean;
  readOnly: boolean;
  tokenEnabled: boolean;
  [key: string]: unknown;
}

/** Named SSE events the server emits alongside the state snapshots. */
export interface AuthorizeRequest {
  requestId: string;
  action: string;
  ctx: unknown;
  expiresAt: number;
}

export interface TokenFirstRun {
  token: string;
  persistPath: string;
  ts: number;
}
