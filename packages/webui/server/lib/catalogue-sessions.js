// webui/server/lib/catalogue-sessions.js
//
// S3 (runtime-first migration step 3): normalizers that bridge the
// catalogue host's `TuiSession` shape to the legacy ACP-protocol
// session shape that the sidebar tree already understands. Without
// this, flipping `MCODE_WEBUI_TRANSPORT=runtime` would either change
// the sidebar (a behavioural diff) or require every consumer of
// `getMcodeSessionsForWorkspace` to learn a second shape (a much
// larger blast radius). The shape emitted here is the exact one
// produced by `McodeAcpClient#listSessions` (`session/list` JSON-RPC
// reply):
//
//   { sessionId: string,
//     cwd:       string|null,
//     title:     string|null,
//     updatedAt: string,                     // ISO 8601; omitted when the
//                                             // runtime has no timestamp
//     ... }
//
// The ACP adapter builds the same shape in `toAcpSessionInfo`
// (packages/tui/src/acp/agent.ts): epoch-ms `TuiSession.updatedAt`
// becomes an ISO string, and the key is omitted entirely when no
// finite timestamp exists. The projection below mirrors that
// conversion so the two paths are field-for-field identical — the
// S3 acceptance criterion is a zero-diff sidebar list.
//
// `acp-client.js` calls these helpers when the catalogue host is
// enabled, and falls back to the ACP path on any throw so the sidebar
// still works when the runtime is unavailable (R1 acceptance target).

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
 * Project a `TuiSession` (catalogue host) onto the ACP list shape.
 * Field set is intentionally minimal — see the comment block above.
 * Any field the runtime advertises but the ACP wire format does not
 * expose (e.g. agentName, sessionKind, model) is dropped here so the
 * sidebar tree cannot start depending on a runtime-only field by
 * accident.
 *
 * @param {object} tui  A TuiSession from `host.adapter.listSessions()`.
 * @returns {{sessionId: string, cwd: string|null, title: string|null, updatedAt?: string}}
 */
export function projectTuiSessionToAcp(tui) {
  if (!tui || typeof tui.sessionId !== "string") {
    throw new Error(
      "projectTuiSessionToAcp: invalid TuiSession (missing sessionId)",
    );
  }
  const updatedAt = tuiUpdatedAtToIso(tui.updatedAt);
  return {
    sessionId: tui.sessionId,
    cwd: tui.workspaceDir || null,
    title: tui.title || null,
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
 * @returns {Promise<Array<{sessionId, cwd, title, updatedAt?}>>}
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
  return tuiSessions.map(projectTuiSessionToAcp);
}

/**
 * Resolve a session title via the catalogue host. Returns `null` if
 * the session does not exist — same contract as the ACP path
 * `getMcodeSessionTitle`.
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
    return session && session.title ? session.title : null;
  } catch {
    // The session may have been deleted between list and lookup;
    // ACP returns null in that case, mirror it.
    return null;
  }
}
