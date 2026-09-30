// webui/server/routes/turn-diff.js
// Per-turn file-change records (webui-parity 83, ticket 80's plan B).
//
//   GET  /api/turn-diff?sessionId=<mvs_…>&assistantMessageId=<id>
//   POST /api/turn-diff/revert   { sessionId, assistantMessageId }
//   POST /api/turn-diff/reapply  { sessionId, assistantMessageId }
//
// Zero new backend. Every endpoint is a thin projection over
// `applications.session.diff` (getTurnDiff / revertTurnDiff / reapplyTurnDiff)
// on the catalogue host — the same runtime application `routes/plugins.js`
// reaches through `getCatalogueHost()`. This file owns input validation, the
// wire shape, and the post-mutation refresh; it owns no diff logic.
//
// Two deliberate constraints, both from the real-run verification in
// `.tickets/webui-parity/82-coord-premise-verification.md`:
//
//   1. `assistantMessageId` is MANDATORY. The engine's selector falls back to
//      `latestForSession` when it receives no id at all (diff-api.ts:209-220),
//      which would answer with ANOTHER turn's counts and — worse — let an undo
//      button act on the wrong turn's files. A request without the id is
//      answered with an empty record and never reaches the engine.
//
//   2. The route exposes `applications.session.diff` and nothing else. The
//      `applications` tree also carries `session.lifecycle`, which can DELETE a
//      session; widening this surface to "the applications handle" would hand
//      that to a diff endpoint. `applications` is read here exactly one level
//      deep.
//
// Gates are not re-implemented: `createHonoApp`'s middleware runs the shared
// chain (`lib/gates.js`) for every owned route, so auth, rate limiting and the
// read-only mode are inherited — a read-only server answers both POSTs with 403
// and that is correct, not a bug.
//
// Wire contract:
//   hit                  200 { ok: true, turnDiff: <TurnDiffView|null> }
//   no coordinate        200 { ok: true, turnDiff: null }   (honest empty)
//   bad request          400 { ok: false, code: "invalidRequest", error }
//   engine refusal       the engine's own status (404 / 409) with
//                        { ok: false, code, error }
//   runtime unavailable  200 { ok: false, code: "RUNTIME_UNAVAILABLE", error }
//
// A 409 is passed through rather than flattened into 200: it is the engine's
// "Only the latest turn diff can be changed" / content-conflict gate, and the
// card shows that message verbatim instead of a generic failure.

import { getCatalogueHost } from "../lib/acp-client.js";
import { readJson } from "../lib/read-json.js";
import { invalidateSessionTree } from "../lib/session-tree.js";
import {
  pushSessionTreeChanged,
  pushWorkspaceFilesChanged,
} from "../lib/state-bus.js";

/** The engine's session id shape, same guard the transcript reader applies. */
const MVS_SESSION_RE = /^mvs_[a-f0-9]{32}$/;

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function badRequest(res, error) {
  json(res, 400, { ok: false, error, code: "invalidRequest" });
}

function notAvailable(res) {
  json(res, 200, {
    ok: false,
    error: "runtime unavailable",
    code: "RUNTIME_UNAVAILABLE",
  });
}

function messageOf(error) {
  if (error && typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

/**
 * Validate the coordinate both endpoints share.
 *
 * `assistantMessageId` missing or blank is NOT a 400 — it is the "this turn
 * has no coordinate" case (a session recorded before the marker shipped, the
 * exec transport, a legacy read). It answers an empty record so the card
 * degrades; only a present-but-wrong `sessionId` is a client error.
 */
function readSelector(source) {
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  if (!MVS_SESSION_RE.test(sessionId)) {
    return { ok: false, error: `sessionId must look like mvs_<32 hex> (got ${JSON.stringify(source.sessionId)})` };
  }
  const assistantMessageId =
    typeof source.assistantMessageId === "string" ? source.assistantMessageId.trim() : "";
  return { ok: true, sessionId, assistantMessageId: assistantMessageId || null };
}

/** `applications.session.diff` — and only that. */
async function defaultGetDiffApplication() {
  const host = await getCatalogueHost();
  const diff = host && host.applications ? host.applications.session?.diff : undefined;
  return diff ?? null;
}

/**
 * Map a thrown engine error onto the wire.
 *
 * `AppError` (local-runtime-v2/application/errors.ts) carries the status the
 * engine chose: 404 for an unknown session, 409 for the only-latest gate and
 * for a content conflict. Both are answers the user needs to read, so both
 * keep their status. Anything else is a 200 data-plane failure, matching the
 * convention `routes/plugins.js` documents.
 */
function respondEngineError(res, error) {
  const status = error && typeof error.status === "number" ? error.status : 0;
  const code = error && typeof error.key === "string" && error.key ? error.key : "TURN_DIFF_ERROR";
  if (status === 404 || status === 409) {
    json(res, status, { ok: false, error: messageOf(error), code });
    return;
  }
  json(res, 200, { ok: false, error: messageOf(error), code });
}

/**
 * Re-read everything a reverted workspace invalidates.
 *
 * A revert rewrites real files under the workspace (`fs.writeFile` / `fs.rm`
 * against the captured snapshot), so the server-side session-tree cache, the
 * sidebar, the open file preview and the git panel are all stale. The server
 * owns the first two — cache invalidation plus the SSE broadcast; the client
 * re-reads the other two off the same `workspace-files-changed` frame.
 */
function refreshAfterMutation() {
  try {
    invalidateSessionTree();
  } catch {
    /* the cache is an optimisation; a failed invalidation must not fail the undo */
  }
  pushSessionTreeChanged();
  pushWorkspaceFilesChanged();
}

/**
 * Shared runner: resolve the diff application, validate, call, answer.
 *
 * `run` returns the 200 payload, or `null` when it already wrote a
 * non-200 answer itself (the engine's `{success:false}` shape, which this
 * route maps to 409) — writing a second header set on a finished response
 * would throw.
 */
async function withDiff(res, deps, run) {
  const getDiff = (deps && deps.getDiffApplication) || defaultGetDiffApplication;
  let diff;
  try {
    diff = await getDiff();
  } catch (error) {
    respondEngineError(res, error);
    return;
  }
  if (!diff) {
    notAvailable(res);
    return;
  }
  try {
    const payload = await run(diff);
    if (payload === null) return;
    json(res, 200, payload);
  } catch (error) {
    respondEngineError(res, error);
  }
}

// ---------------------------------------------------------------------------
// GET /api/turn-diff — this turn's record, or an honest empty
// ---------------------------------------------------------------------------

export async function handleTurnDiff(req, res, _ctx, deps = {}) {
  const url = new URL(req.url, "http://localhost");
  const selector = readSelector({
    sessionId: url.searchParams.get("sessionId"),
    assistantMessageId: url.searchParams.get("assistantMessageId"),
  });
  if (!selector.ok) return badRequest(res, selector.error);
  // No coordinate → no engine call. Falling through here would return the
  // engine's latest turn, i.e. another turn's numbers under this card.
  if (!selector.assistantMessageId) {
    return json(res, 200, { ok: true, turnDiff: null });
  }
  return withDiff(res, deps, async (diff) => {
    const turnDiff = await diff.getTurnDiff({}, {
      id: selector.sessionId,
      assistantMessageId: selector.assistantMessageId,
    });
    return { ok: true, turnDiff: turnDiff ?? null };
  });
}

// ---------------------------------------------------------------------------
// POST /api/turn-diff/revert — undo this turn's edits (latest turn only)
// ---------------------------------------------------------------------------

export async function handleTurnDiffRevert(req, res, _ctx, deps = {}) {
  const body = await readJson(req);
  const selector = readSelector(body ?? {});
  if (!selector.ok) return badRequest(res, selector.error);
  if (!selector.assistantMessageId) return json(res, 200, { ok: true, turnDiff: null });
  return withDiff(res, deps, async (diff) => {
    const result = await diff.revertTurnDiff({}, {
      id: selector.sessionId,
      assistantMessageId: selector.assistantMessageId,
    });
    // The engine answers `{success:false, error}` without throwing only for
    // cases it treats as data; a false success must not read as a silent undo.
    if (result && result.success === false) {
      json(res, 409, { ok: false, error: result.error || "revert failed", code: "TURN_DIFF_CONFLICT" });
      return null;
    }
    refreshAfterMutation();
    return { ok: true, turnDiff: (result && result.turnDiff) ?? null };
  });
}

// ---------------------------------------------------------------------------
// POST /api/turn-diff/reapply — put this turn's edits back
// ---------------------------------------------------------------------------

export async function handleTurnDiffReapply(req, res, _ctx, deps = {}) {
  const body = await readJson(req);
  const selector = readSelector(body ?? {});
  if (!selector.ok) return badRequest(res, selector.error);
  if (!selector.assistantMessageId) return json(res, 200, { ok: true, turnDiff: null });
  return withDiff(res, deps, async (diff) => {
    const { success, error, ...turnDiff } = await diff.reapplyTurnDiff({}, {
      id: selector.sessionId,
      assistantMessageId: selector.assistantMessageId,
    });
    if (success === false) {
      json(res, 409, { ok: false, error: error || "reapply failed", code: "TURN_DIFF_CONFLICT" });
      return null;
    }
    refreshAfterMutation();
    return { ok: true, turnDiff };
  });
}
