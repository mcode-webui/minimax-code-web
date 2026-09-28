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
//     updatedAt: number|string|undefined,   // optional; ACP does not guarantee
//     ... }
//
// `acp-client.js` calls these helpers when the catalogue host is
// enabled, and falls back to the ACP path on any throw so the sidebar
// still works when the runtime is unavailable (R1 acceptance target).

/**
 * Project a `TuiSession` (catalogue host) onto the ACP list shape.
 * Field set is intentionally minimal — see the comment block above.
 * Any field the runtime advertises but the ACP wire format does not
 * expose (e.g. agentName, sessionKind, model) is dropped here so the
 * sidebar tree cannot start depending on a runtime-only field by
 * accident.
 *
 * @param {object} tui  A TuiSession from `host.adapter.listSessions()`.
 * @returns {{sessionId: string, cwd: string|null, title: string|null}}
 */
export function projectTuiSessionToAcp(tui) {
  if (!tui || typeof tui.sessionId !== "string") {
    throw new Error(
      "projectTuiSessionToAcp: invalid TuiSession (missing sessionId)",
    );
  }
  return {
    sessionId: tui.sessionId,
    cwd: tui.workspaceDir || null,
    title: tui.title || null,
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
 * @returns {Promise<Array<{sessionId, cwd, title}>>}
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
