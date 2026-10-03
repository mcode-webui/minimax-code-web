// webui/server/lib/authorize.js
// Per-request authorization helper.
//
// `authorize(action, ctx, opts)` blocks on user confirmation; the UI
// pops a modal listening for the `needs_authorization` SSE event. The
// user accepts or declines; the server resolves the pending promise
// via POST /api/auth/decision.
//
// Default timeout = 5 minutes. Timeout = reject (fail-closed: a
// silent fallback to "approved" is the root cause of accidental
// destructive actions).
//
// The timeout is the budget for a HUMAN who was shown a modal. It is
// not the right answer to "nobody was ever shown one": when the
// request's target has no live SSE connection, the decision channel is
// empty, the fail-closed answer is already determined, and the caller
// is told so at once (`auth.unreachable`) instead of holding a
// destructive HTTP request open for the full budget. See
// `state-bus.js#hasDecisionListener`.
//
// Audit: every approve / reject / timeout writes one NDJSON event via
// the static import of `server/lib/events.js`. The DECISION-OUTCOME
// audit write (auth.approve/reject/timeout/cancelled) is
// loud-but-non-blocking: on write failure we pushAlert + console.error
// and still resolve the user's decision, because a click in the
// modal is irreversible — throwing away the user's explicit choice
// to spite a broken disk would turn one failure into two. The
// destructive action itself is separately guarded by the route-level
// write-ahead intent events (see routes/sessions.js etc.), which DO
// fail closed.
//
// Pure module: no fs / spawn / router side-effects on import. The
// `handleAuthDecision` HTTP handler is exported for the router.
//
// Action whitelist:
//   session.delete          DELETE /api/sessions/:id (destructive)
//   sessions.cleanup-orphans POST /api/sessions/cleanup-orphans
//   session.cleanup-all     bulk delete (extension hook)
//   session.export          GET /api/sessions/:id/export (non-destructive
//                           but exposes conversation history; same gate class
//                           as session.delete)
//   session.search          GET /api/sessions/search (non-destructive
//                           but surfaces titles across workspaces the user
//                           is not currently in; same gate class as export)
//   token.reset             rotate the LAN auth token
//   slash.clear             /clear and /new on the chat stream
//   startup.cleanup         boot-time orphan sweep
//   auth.unreachable        (audit kind, not an action) the request was
//                           raised with no connected client to answer it

import { randomUUID } from "node:crypto";
import { pushAuthRequest, pushAuthDecision, hasDecisionListener } from "./state-bus.js";
import { pushAlert } from "./alerts.js";
import { append as _eventsAppend } from "./events.js";
import { readJson } from "./read-json.js";

// ---------- action whitelist ----------

export const AUTHORIZE_ACTIONS = Object.freeze([
  "session.delete",
  "sessions.cleanup-orphans",
  "session.cleanup-all",
  "session.export",
  "session.search",
  "token.reset",
  "slash.clear",
  "startup.cleanup",
]);

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function _isValidAction(action) {
  return AUTHORIZE_ACTIONS.includes(action);
}

// ---------- pending request registry ----------

// requestId → { resolve, timer, action, ctx, requestedAt, expiresAt }
const _pending = new Map();

// Test-only: true while an in-process decision driver is attached. See
// `_setInProcessDeciderAttached` — it is false for the whole of a
// production process, and it can only ever turn the unreachability
// short-circuit OFF, never on.
let _inProcessDeciderAttached = false;

// ---------- audit ----------

// _tryWriteEvent — synchronous, loud-but-non-blocking audit write.
// events.js#append is fail-closed (throws); authorize deliberately
// does NOT propagate that throw:
//   - For decision-OUTCOME events (auth.approve / auth.reject /
//     auth.timeout / auth.cancelled) the user's click already
//     happened and is irreversible. Swallowing the DECISION would
//     deadlock the modal on a broken audit disk AND lose the user's
//     explicit choice; the destructive mutation downstream is guarded
//     by the route-level write-ahead intent events, which do fail
//     closed. So: record the miss on the anomaly channel (pushAlert)
//     + stderr, then continue.
//   - For auth.pending / auth.bypass the same loud-continue applies:
//     these are observability lines, not the enforcement line.
function _tryWriteEvent(evt) {
  try {
    // Normalize to the events.js#append(kind, fields) signature.
    // (`data` → `payload`: append() only accepts the payload via the
    // explicit `payload` key when meta keys (target/cid/actor) are
    // present.)
    _eventsAppend(evt.kind, {
      target: evt.target || "",
      cid: evt.cid || "",
      actor: evt.actor || "system",
      payload: evt.data && typeof evt.data === "object" ? evt.data : {},
    });
  } catch (e) {
    try {
      pushAlert({
        level: "error",
        msg: `auth audit write failed (kind=${evt && evt.kind}): ${e.message}`,
        src: "authorize",
      });
    } catch {}
    console.error(
      `[webui] authorize audit write failed (kind=${evt && evt.kind}): ${e.message}`,
    );
  }
}

// ---------- core API ----------

// authorize(action, ctx, opts) → Promise<{approved, decidedBy, decidedAt}>
//   action: one of AUTHORIZE_ACTIONS (throws on invalid)
//   ctx:    { cid: string, [any extra context] } — cid is optional;
//           empty cid = broadcast to all SSE clients
//   opts:   { timeoutMs?: number, metadata?: object, bypass?: boolean }
//           bypass=true skips the user gate (only for trusted internal
//           callers — e.g. LAN token rotation triggered by the
//           settings card modal that already presented its own
//           confirmation UI).
//
// There is deliberately NO test-mode auto-approve. A prior branch
// inspected Node's runtime flag vector for --test /
// --experimental-test-module-mocks and approved every gated action
// without a user decision — meaning no test exercised the real
// decision path, and any future flag confusion in the production flag
// vector would silently disable the gate. Tests now drive the REAL
// path via test/_setup.js#withDecisions (in process) or SSE +
// POST /api/auth/decision (integration).
//
// Returns:
//   { approved: true,  decidedBy: 'user',   decidedAt: ms }
//   { approved: false, decidedBy: 'user',   decidedAt: ms }   (user declined)
//   { approved: false, decidedBy: 'timeout',decidedAt: ms }   (default fail-closed)
export function authorize(action, ctx = {}, opts = {}) {
  if (!_isValidAction(action)) {
    return Promise.resolve({
      approved: false,
      decidedBy: "rejected",
      decidedAt: Date.now(),
      reason: `invalid action: ${action}`,
    });
  }
  if (opts.bypass === true) {
    // trusted internal caller — record audit but skip user gate
    _tryWriteEvent({
      kind: "auth.bypass",
      target: action,
      cid: (ctx && ctx.cid) || null,
      data: opts.metadata || null,
    });
    return Promise.resolve({
      approved: true,
      decidedBy: "bypass",
      decidedAt: Date.now(),
    });
  }
  const cid = (ctx && typeof ctx.cid === "string") ? ctx.cid : "";
  const requestId = randomUUID();
  const requestedAt = Date.now();
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const expiresAt = requestedAt + timeoutMs;
  const safeCtx = ctx && typeof ctx === "object" ? ctx : {};

  return new Promise((resolve) => {
    // Can this request be decided at all? The gate is a push to a live
    // SSE response, so "no connected client" is not a slow answer, it is
    // the absence of one: the only outcome still reachable is the
    // fail-closed timeout, `timeoutMs` from now. Making the caller wait
    // out the whole budget to arrive at an answer that was already
    // determined is what a destructive request looks like when it hangs —
    // an open socket, no status, no body, for five minutes.
    //
    // So reach that answer now instead. This is a wait that is removed,
    // not a wait that is shortened: the resolution value, the
    // `authorization_decided` frame other tabs mirror, and the fail-closed
    // posture are the timeout path's, and nothing is ever approved
    // without a decision.
    //
    // A bus that cannot answer the question — an older build, a test
    // double that does not model the connection registry — is NOT
    // evidence that nobody is listening, so it keeps the previous
    // behaviour and waits for the timeout. Only a bus that positively
    // reports an empty channel short-circuits.
    let answerable = true;
    try {
      answerable = hasDecisionListener(cid) !== false;
    } catch {
      answerable = true;
    }
    if (!answerable && !_inProcessDeciderAttached) {
      const decidedAt = Date.now();
      _tryWriteEvent({
        kind: "auth.unreachable",
        target: action,
        cid: cid || null,
        data: {
          requestId,
          requestedAt,
          expiresAt,
          timeoutMs,
          reason: "no_connected_client",
          metadata: opts.metadata || null,
        },
      });
      // Same frame the timeout path emits, so a tab that reconnects and
      // replays its state closes any modal it may have optimistically
      // opened on its own request.
      try {
        pushAuthDecision({ requestId, approved: false, decidedBy: "timeout" });
      } catch {}
      resolve({ approved: false, decidedBy: "timeout", decidedAt });
      return;
    }
    const timer = setTimeout(() => {
      const entry = _pending.get(requestId);
      if (!entry) return;
      _pending.delete(requestId);
      const decidedAt = Date.now();
      _tryWriteEvent({
        kind: "auth.timeout",
        target: action,
        cid: cid || null,
        data: {
          requestId,
          requestedAt,
          expiresAt,
          metadata: opts.metadata || null,
        },
      });
      // Mirror the resolution over SSE so other tabs close the modal.
      try {
        pushAuthDecision({ requestId, approved: false, decidedBy: "timeout" });
      } catch {}
      resolve({ approved: false, decidedBy: "timeout", decidedAt });
    }, timeoutMs);
    // Allow process to exit even if a request is pending (unref).
    if (typeof timer.unref === "function") timer.unref();

    _pending.set(requestId, {
      resolve,
      timer,
      action,
      ctx: safeCtx,
      requestedAt,
      expiresAt,
    });

    // Push the request to the target cid (or broadcast if cid is empty).
    try {
      pushAuthRequest({
        requestId,
        action,
        ctx: safeCtx,
        expiresAt,
      });
    } catch {}
    // Audit the pending request itself (best-effort).
    _tryWriteEvent({
      kind: "auth.pending",
      target: action,
      cid: cid || null,
      data: {
        requestId,
        requestedAt,
        expiresAt,
        timeoutMs,
        metadata: opts.metadata || null,
      },
    });
  });
}

// ---------- HTTP handler ----------

// handleAuthDecision — POST /api/auth/decision
//   body: { requestId: string, approve: boolean }
//   responses:
//     200 { ok: true, approved, decidedBy }   (resolved)
//     400 { ok: false, error }              (bad request)
//     404 { ok: false, error: 'not found' }  (no such pending request)
//     410 { ok: false, error: 'already decided' } (idempotency guard)
export async function handleAuthDecision(req, res) {
  const body = await readJson(req);
  const requestId = body && typeof body.requestId === "string" ? body.requestId : "";
  const approve = !!(body && body.approve === true);
  if (!requestId) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "requestId required" }));
  }
  const entry = _pending.get(requestId);
  if (!entry) {
    // Either already decided, expired, or never existed.
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "no pending request with that id" }));
  }
  _pending.delete(requestId);
  if (entry.timer) clearTimeout(entry.timer);
  const decidedAt = Date.now();
  const decidedBy = "user";
  const cid = (entry.ctx && entry.ctx.cid) || null;
  _tryWriteEvent({
    kind: approve ? "auth.approve" : "auth.reject",
    target: entry.action,
    cid,
    data: {
      requestId,
      requestedAt: entry.requestedAt,
      decidedAt,
      durationMs: decidedAt - entry.requestedAt,
    },
  });
  try {
    pushAuthDecision({ requestId, approved: approve, decidedBy });
  } catch {}
  entry.resolve({ approved: approve, decidedBy, decidedAt });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, approved: approve, decidedBy, decidedAt }));
}

// ---------- test-only / diagnostics ----------

export function getPendingCount() {
  return _pending.size;
}

export function getPendingRequestIds() {
  return Array.from(_pending.keys());
}

/**
 * The pending requests with the client each one is waiting on.
 *
 * Exists beside `getPendingRequestIds` for one reason: a request only
 * stays pending while its target has a live connection
 * (`state-bus.js#hasDecisionListener`), so a caller that drives decisions
 * in-process has to present a connection for the right client before it
 * can decide anything. A test that models only the decision and not the
 * channel is not modelling the product.
 *
 * @returns {Array<{requestId: string, cid: string, action: string}>}
 */
export function getPendingTargets() {
  return Array.from(_pending, ([requestId, entry]) => ({
    requestId,
    cid: (entry.ctx && entry.ctx.cid) || "",
    action: entry.action,
  }));
}

/**
 * Declare that a decision driver is attached in-process, which makes a
 * pending request answerable regardless of the connection registry.
 *
 * The unreachability short-circuit above asks "could anybody be asked?",
 * and in production the only thing that can answer is a live SSE
 * connection. A test harness that drives decisions through
 * `_decideForTests` IS that somebody — it just has no socket — and it
 * cannot know which cid a route is about to use before the route runs.
 * This flag is how it says so, and it is the same claim the harness
 * already makes by deciding the request at all.
 *
 * It is false for the whole of a production process, and it can only
 * DISABLE the short-circuit — it can never turn an empty channel into an
 * approval, and it never bypasses the gate itself. A test that wants the
 * short-circuit's behaviour simply does not attach a decider, which is
 * how `test/routes/sessions.check.mjs` pins the unreachable DELETE.
 *
 * @param {boolean} attached
 */
export function _setInProcessDeciderAttached(attached) {
  _inProcessDeciderAttached = !!attached;
}

export function _resetForTests() {
  // Resolve every pending request as "reset" so any awaiting test
  // does not hang; clear timers and the registry.
  for (const [id, entry] of _pending) {
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.resolve({ approved: false, decidedBy: "reset", decidedAt: Date.now() });
    } catch {}
  }
  _pending.clear();
}

// Resolve a pending request without going through HTTP. Used by tests
// (and could be used by internal flows that already have a different
// confirmation path — e.g. C08 token modal).
export function _decideForTests(requestId, approve) {
  const entry = _pending.get(requestId);
  if (!entry) return false;
  _pending.delete(requestId);
  if (entry.timer) clearTimeout(entry.timer);
  const decidedAt = Date.now();
  _tryWriteEvent({
    kind: approve ? "auth.approve" : "auth.reject",
    target: entry.action,
    cid: (entry.ctx && entry.ctx.cid) || null,
    data: { requestId, decidedAt },
  });
  try {
    pushAuthDecision({ requestId, approved: approve, decidedBy: "user" });
  } catch {}
  entry.resolve({ approved: approve, decidedBy: "user", decidedAt });
  return true;
}

// Drop every pending request belonging to a cid (e.g. on tab close).
// Each request resolves as `decidedBy: 'cancelled'`, decidedAt set;
// kind: 'auth.cancelled' is appended to the audit trail.
export function clearPendingForCid(cid, reason = "cid closed") {
  if (!cid) return 0;
  let n = 0;
  for (const [id, entry] of _pending) {
    if (!entry.ctx || entry.ctx.cid !== cid) continue;
    _pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const decidedAt = Date.now();
    _tryWriteEvent({
      kind: "auth.cancelled",
      target: entry.action,
      cid,
      data: { requestId: id, decidedAt, reason },
    });
    try {
      entry.resolve({ approved: false, decidedBy: "cancelled", decidedAt });
    } catch {}
    n++;
  }
  return n;
}