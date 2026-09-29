// webui/server/lib/catalogue-sessions.js
//
// S3 (runtime-first migration step 3): normalizers that bridge the
// catalogue host's `TuiSession` shape to the legacy ACP-protocol
// session shape that the sidebar tree already understands. Without
// this, flipping `MCODE_WEBUI_TRANSPORT=runtime` would either change
// the sidebar (a behavioural diff) or require every consumer of
// `getMcodeSessionsForWorkspace` to learn a second shape (a much
// larger blast radius). The shape emitted here is the one produced by
// `McodeAcpClient#listSessions` (`session/list` JSON-RPC reply).
//
// The projection mirrors every rule of the ACP adapter's
// `toAcpSessionInfo` (packages/tui/src/acp/agent.ts), which the
// `session/list` handler applies per entry. The rules, in order:
//
//   1. Internal sub-agent sessions are dropped whole — a session whose
//      `sessionKind` is `"task"`, whose `purpose` starts with a worker
//      prefix (`local-task:` / `local-background-task:` / `team-plan:`),
//      or whose `agentName` is a builtin sub-agent name
//      (`explore` / `worker` / `verifier`) never reaches the wire.
//      (Mirror of `isTuiInternalSubagentSession`,
//      packages/tui/src/runtime/delegation.ts.)
//   2. Sessions without a cwd, or with a non-absolute cwd, are dropped
//      whole — the ACP shape carries `cwd: string`, never `cwd: null`,
//      so there is no projection for a cwd-less session.
//   3. `title` is omitted when empty — the ACP shape has no
//      `title: null`, an unnamed session simply carries no title key.
//   4. `updatedAt` is omitted when no finite timestamp exists —
//      epoch-ms numbers (and numeric strings) become ISO strings,
//      anything unparseable drops the key.
//
// Known intentional difference, not a parity gap: ACP `session/list`
// is cursor-paginated and this projection always takes the first page
// (`adapter.listSessions` takes no cursor), which matches what the
// webui ACP client itself fetches — `McodeAcpClient#listSessions`
// never follows `nextCursor` either, so both paths show the sidebar
// the same first page.
//
// The sub-agent constants above are a copy of the ACP side's. If the
// engine renames a worker prefix or adds a builtin sub-agent name,
// both this file and delegation.ts must move together; the drop-rule
// parity tests in webui/test/server/catalogue-via-runtime.test.js go
// red when they drift.
//
// `acp-client.js` calls these helpers when the catalogue host is
// enabled, and falls back to the ACP path on any throw so the sidebar
// still works when the runtime is unavailable (R1 acceptance target).

import { isAbsolute } from "node:path";

// Mirrors WORKER_PURPOSE_PREFIXES / BUILTIN_SUBAGENT_NAMES in
// packages/tui/src/runtime/delegation.ts — see the header comment.
const WORKER_PURPOSE_PREFIXES = [
  "local-task:",
  "local-background-task:",
  "team-plan:",
];
const BUILTIN_SUBAGENT_NAMES = new Set(["explore", "worker", "verifier"]);

/**
 * Mirror of `isTuiInternalSubagentSession`
 * (packages/tui/src/runtime/delegation.ts): true for delegated worker
 * sessions (`sessionKind === "task"` or a worker `purpose` prefix) and
 * for builtin sub-agent sessions (`agentName` in the builtin set).
 * The ACP adapter drops these from `session/list`; the projection
 * must agree or the runtime-mode sidebar would list internal
 * sub-agent sessions the ACP mode hides.
 *
 * @param {object} tui  A TuiSession from `host.adapter.listSessions()`.
 * @returns {boolean}
 */
function isInternalSubagentSession(tui) {
  const purpose = typeof tui.purpose === "string" ? tui.purpose : "";
  const delegated =
    tui.sessionKind === "task" ||
    WORKER_PURPOSE_PREFIXES.some((prefix) => purpose.startsWith(prefix));
  const agentName = tui.agentName?.trim().toLocaleLowerCase();
  const builtin =
    agentName !== undefined && BUILTIN_SUBAGENT_NAMES.has(agentName);
  return delegated || builtin;
}

/**
 * Convert a `TuiSession` timestamp to the ISO string the ACP wire
 * format carries. Mirrors `toIsoTimestamp` in packages/tui/src/acp/
 * agent.ts: numbers are epoch ms; strings are tried as numeric first,
 * then as a parseable date; anything unparseable yields `undefined`
 * (the key is then omitted, matching the ACP adapter).
 *
 * @param {number|string|null|undefined} value
 * @returns {string|undefined}
 */
function tuiUpdatedAtToIso(value) {
  if (value === undefined || value === null) return undefined;
  const numeric =
    typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  const timestamp =
    typeof value === "number"
      ? value
      : Number.isFinite(numeric)
        ? numeric
        : Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

/**
 * Project a `TuiSession` (catalogue host) onto the ACP list shape,
 * applying every `toAcpSessionInfo` rule from the header comment.
 * Returns `null` for a session the ACP adapter would drop whole
 * (internal sub-agent, missing/non-absolute cwd); callers filter the
 * nulls out. Field set is intentionally minimal — any field the
 * runtime advertises but the ACP wire format does not expose (e.g.
 * agentName, sessionKind, model) is dropped here so the sidebar tree
 * cannot start depending on a runtime-only field by accident.
 *
 * @param {object} tui  A TuiSession from `host.adapter.listSessions()`.
 * @returns {{sessionId: string, cwd: string, title?: string, updatedAt?: string}|null}
 */
export function projectTuiSessionToAcp(tui) {
  if (!tui || typeof tui.sessionId !== "string") {
    throw new Error(
      "projectTuiSessionToAcp: invalid TuiSession (missing sessionId)",
    );
  }
  if (isInternalSubagentSession(tui)) return null;
  const cwd = tui.workspaceDir;
  if (!cwd || !isAbsolute(cwd)) return null;
  const updatedAt = tuiUpdatedAtToIso(tui.updatedAt);
  return {
    sessionId: tui.sessionId,
    cwd,
    ...(tui.title ? { title: tui.title } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * List sessions via the catalogue host and normalize to ACP shape.
 * The page is the same shape that ACP returns under `sessions: [...]`
 * (i.e. an array — ACP pagination is cursor-based and we ignore it
 * for the sidebar's first page, matching the legacy `getMcodeSessions
 * ForWorkspace` behaviour).
 *
 * @param {object} catalogueHost  Object returned by `createCatalogueHost`.
 * @returns {Promise<Array<{sessionId: string, cwd: string, title?: string, updatedAt?: string}>>}
 */
export async function listMcodeSessionsViaRuntime(catalogueHost) {
  if (!catalogueHost || !catalogueHost.adapter) {
    throw new Error("listMcodeSessionsViaRuntime: catalogueHost.adapter is required");
  }
  const tuiSessions = await catalogueHost.adapter.listSessions();
  if (!Array.isArray(tuiSessions)) {
    // Catalogue host must always return an array; a non-array is a
    // contract break we want to surface loudly.
    throw new Error(
      `listMcodeSessionsViaRuntime: catalogue host returned non-array (${typeof tuiSessions})`,
    );
  }
  // `projectTuiSessionToAcp` yields null for sessions the ACP adapter
  // drops whole (see header); those never reach the sidebar.
  return tuiSessions
    .map(projectTuiSessionToAcp)
    .filter((session) => session !== null);
}

/**
 * Resolve a session title via the catalogue host. Returns `null` if
 * the session does not exist — same contract as the ACP path
 * `getMcodeSessionTitle`. Sessions the projection drops whole
 * (internal sub-agent, missing/non-absolute cwd) also answer `null`:
 * the ACP path resolves titles from its already-filtered `session/list`
 * page, so a dropped session has no title there either.
 *
 * @param {object} catalogueHost  Object returned by `createCatalogueHost`.
 * @param {string} mcodeSessionId
 * @returns {Promise<string|null>}
 */
export async function getMcodeSessionTitleViaRuntime(
  catalogueHost,
  mcodeSessionId,
) {
  if (!catalogueHost || !catalogueHost.adapter) {
    throw new Error(
      "getMcodeSessionTitleViaRuntime: catalogueHost.adapter is required",
    );
  }
  if (!mcodeSessionId) return null;
  try {
    const session = await catalogueHost.adapter.getSession(mcodeSessionId);
    if (!session) return null;
    if (isInternalSubagentSession(session)) return null;
    if (!session.workspaceDir || !isAbsolute(session.workspaceDir)) {
      return null;
    }
    return session.title || null;
  } catch {
    // The session may have been deleted between list and lookup;
    // ACP returns null in that case, mirror it.
    return null;
  }
}
