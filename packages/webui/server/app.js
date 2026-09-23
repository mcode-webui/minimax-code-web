// webui/server/app.js
// The Hono application.
//
// `OWNED_ROUTES` below is the ledger: a request is served by Hono when its
// `METHOD /path` is listed, and by `router.js` otherwise. Each request is
// served by exactly one of the two layers, which is what keeps the gates
// un-duplicated — they run once, in `lib/gates.js`, whichever layer serves
// the request.
//
// Two decisions worth knowing before adding a route here:
//
// 1. Gates, not a copy of the gates. `runGates` is the same function
//    `router.js` calls. It takes a Node-ish `res` and *writes to it* when
//    a gate stops a request, so Hono-owned routes hand it
//    `createResponseCapture()` instead of the socket — the gate's status,
//    headers and body are captured, then turned into a real Hono response.
//    The alternative, letting a gate write to the socket and asking
//    `@hono/node-server` to keep its hands off via its internal
//    `x-hono-already-sent` header, was measured and rejected: it is an
//    undocumented internal, and it is bypassed entirely when Hono takes
//    its immediate-cacheable path — which produced a real
//    ERR_HTTP_HEADERS_SENT during evaluation.
//
// 2. Handlers are reused, not rewritten. An existing route handler is a
//    `(req, res, ctx)` function that writes to `res`; giving it the same
//    capture object turns it into a Hono handler with no duplicated
//    payload. That is why migrating a route is bookkeeping rather than
//    reimplementation.
//
// What stays on `router.js` (and why):
//   - `GET /api/events` and `GET /api/alerts` are SSE streams whose writer
//     is held by `lib/state-bus.js` and reused across pushes (with
//     `res.write(frame)` mid-flight). `createResponseCapture` records to a
//     buffer — it cannot model that without a streaming variant, and adding
//     one would still need verification against Hono's `c.body(stream)` path
//     with `Response(ReadableStream)`. SSE migration is P2.
//   - The dispatcher-level 301/redirects for the trajectory studio mount
//     stay on the legacy dispatcher because they short-circuit before any
//     router.js table lookup.
//   - Static, SPA fallback, and `OPTIONS` preflight also stay — they were
//     never interested in `OWNED_ROUTES`.

import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";

import { runGates } from "./lib/gates.js";
import { getCidFromReq, getClient } from "./lib/state-bus.js";

import * as healthRoute from "./routes/health.js";
import * as stateRoute from "./routes/state.js";
import * as sessionsRoute from "./routes/sessions.js";
import * as exportRoute from "./routes/export.js";
import * as chatRoute from "./routes/chat.js";
import * as usageRoute from "./routes/usage.js";
import * as workspaceRoute from "./routes/workspace.js";
import * as fsRoute from "./routes/fs.js";
import * as settingsRoute from "./routes/settings.js";
import * as uploadRoute from "./routes/upload.js";
import * as modelRoute from "./routes/model.js";
import * as debugRoute from "./routes/debug.js";
import * as protocolRoute from "./routes/protocol.js";
import * as authorizeRoute from "./lib/authorize.js";

/**
 * Routes Hono currently owns, as `METHOD /path`.
 *
 * Patterns that need path parameters (`/api/sessions/:id/export`,
 * `DELETE /api/sessions/:id`) are listed with the literal shape that
 * `ownsRequest` will be asked about — the Hono router resolves the `:id`
 * to its own param, but the ledger is greppable for the literal path that
 * arrives at `server.js`.
 *
 * Everything absent from this set stays on `router.js`. Grow it one group at a time;
 * `ownsRequest` is the only consumer, so the ledger is greppable.
 */
export const OWNED_ROUTES = new Set([
  // Health.
  "GET /api/health",
  // State snapshot — replaces the legacy `GET /api/state`. The companion SSE
  // channel (`GET /api/events`) is not migrated yet (see header comment).
  "GET /api/state",
  // Session CRUD (list/create/switch/search/cleanup).
  "GET /api/sessions",
  "POST /api/sessions",
  "POST /api/sessions/switch",
  "POST /api/sessions/rename",
  "GET /api/sessions/search",
  "POST /api/sessions/cleanup-orphans",
  "DELETE /api/sessions/:id",
  // Sidebar session tree, served from mcode's runtime db.
  "GET /api/session-tree",
  // ACP session list + title helpers.
  "GET /api/acp-sessions",
  "GET /api/acp-session-title",
  // Session export (Markdown / JSON). The `:` is Hono's parameter marker;
  // matches `/api/sessions/<id>/export`.
  "GET /api/sessions/:id/export",
  // Chat: fire-and-forget (output pushed via /api/events SSE).
  "POST /api/send",
  "POST /api/stop",
  "POST /api/cmd",
  // Usage / quota.
  "POST /api/usage",
  "POST /api/usage-trigger",
  "GET /api/usage-real",
  "POST /api/refresh",
  "GET /api/usage/forecast",
  // Workspace.
  "POST /api/workspace",
  "GET /api/workspace/browse",
  "GET /api/workspace/tree",
  "GET /api/workspace/resolve",
  "GET /api/workspace/recent",
  "POST /api/workspace/pick",
  // Native-style fs picker.
  "GET /api/fs/read",
  "POST /api/fs/mkdir",
  // Settings.
  "GET /api/settings",
  "POST /api/settings",
  // Authorize gate close path.
  "POST /api/auth/decision",
  // Multipart file upload.
  "POST /api/upload",
  // Model + permission modes.
  "GET /api/models",
  "POST /api/set-model",
  "POST /api/permissions",
  "GET /api/permissions-modes",
  "POST /api/answer",
  // Debug injection (gated by DEBUG_INJECT=1).
  "POST /api/debug/inject",
  "GET /api/debug/state",
  // mcode acp protocol RPC.
  "POST /api/protocol/set-mode",
  "POST /api/protocol/set-config-option",
  "POST /api/protocol/cancel",
  "POST /api/protocol/load-session",
  "POST /api/protocol/activate-session",
  "GET /api/protocol/list-sessions",
  "GET /api/protocol/capabilities",
]);

/**
 * True when Hono should serve this request rather than the legacy dispatcher.
 *
 * Compares against the Hono app's actual router table (rather than the
 * `OWNED_ROUTES` ledger) so parameterised routes match their real path
 * without us having to mirror the regex by hand. `OWNED_ROUTES` stays as
 * a greppable checklist and a literal-string source for
 * `scripts/check-docs-alignment.mjs`; this function is the runtime
 * decision-maker.
 */
export function ownsRequest(method, pathname, app = null) {
  const a = app ?? createHonoApp();
  // Hono exposes its router table as a property, not a method
  // (`routes: RouterRoute[]` in hono-base.d.ts).
  const routes = a.routes;
  for (const r of routes) {
    if (r.method !== method) continue;
    if (matchHonoPath(r.path, pathname)) return true;
  }
  return false;
}

/**
 * Match a real pathname against a Hono router pattern.
 *
 * Hono's public `app.routes()` returns the pattern as a string
 * (`/api/sessions/:id/export`) rather than a compiled regex, so we do the
 * translation here. Limited to the patterns we actually use: literal
 * segments and `:name` placeholders that match `[^/]+`. The router does
 * not currently use wildcards or optional segments, so anything more
 * elaborate would warrant widening this helper at the same time the
 * router grows.
 */
function matchHonoPath(pattern, pathname) {
  let regexBody = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === ":") {
      // `:name` — capture a non-empty segment.
      const m = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(pattern.slice(i));
      if (!m) {
        regexBody += escapeRegexChar(c);
        i += 1;
        continue;
      }
      regexBody += "([^/]+)";
      i += m[0].length;
    } else {
      regexBody += escapeRegexChar(c);
      i += 1;
    }
  }
  return new RegExp("^" + regexBody + "$").test(pathname);
}

function escapeRegexChar(c) {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? "\\" + c : c;
}

/**
 * A stand-in for Node's `ServerResponse` that records instead of writing.
 *
 * Only the surface the gate chain and the route handlers actually touch is
 * implemented. That is deliberate: a silent no-op for anything else would hide a
 * handler that has grown a dependency this shim does not model, and the response would
 * look fine while dropping whatever it wrote.
 */
export function createResponseCapture() {
  const headers = new Map();
  let status = 200;
  let body = "";
  let sent = false;
  return {
    get headersSent() {
      return sent;
    },
    get statusCode() {
      return status;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      if (nextHeaders) {
        for (const [key, value] of Object.entries(nextHeaders)) {
          headers.set(String(key).toLowerCase(), String(value));
        }
      }
      sent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        body += typeof chunk === "string" ? chunk : String(chunk);
      }
      sent = true;
      return this;
    },
    /** The captured result, for turning into a Hono response. */
    result() {
      return { status, headers, body };
    },
  };
}

// Context keys for the per-request capture and ctx (see the middleware).
const CAPTURE_KEY = "mcodeWebuiResponseCapture";
const CTX_KEY = "mcodeWebuiRequestCtx";

/** Turn a capture into a Hono response, preserving status and headers verbatim. */
function responseFromCapture(c, capture) {
  const { status, headers, body } = capture.result();
  return c.newResponse(body || null, status, Object.fromEntries(headers));
}

/**
 * Bridge Hono's middleware to the existing `(req, res, ctx)` handler signature.
 *
 * `c.env.incoming` is the Node IncomingMessage handed in by
 * `@hono/node-server` via `getRequestListener`, so any handler that does
 * `req.url` / `req.headers` / body streaming keeps working unchanged.
 *
 * Async handlers return a Promise that resolves to nothing (or `undefined`);
 * we must return *that* Promise to Hono rather than wrapping the whole call
 * in `async`, or Hono gets `Promise<Promise<Response>>` and reads `.status`
 * off the inner Promise — which is `undefined` — and `writeHead(undefined)`
 * throws `ERR_HTTP_INVALID_STATUS_CODE` inside `responseViaResponseObject`.
 */
function invokeHandler(c, capture, handler) {
  const ctx = c.get(CTX_KEY);
  const handled = handler(c.env.incoming, capture, ctx);
  if (handled && typeof handled.then === "function") {
    // Async handler — let Hono await the real Response we synthesise once
    // the handler has populated the capture.
    return handled.then(() => responseFromCapture(c, capture));
  }
  return responseFromCapture(c, capture);
}

/** Build the Hono app. Cheap, and built per call so no state is shared between tests. */
export function createHonoApp() {
  const app = new Hono();

  // Gates first, for every owned route — the same chain, in the same order, that the
  // legacy dispatcher runs. A gate that stops the request has already written its
  // response into the capture, so it is returned verbatim.
  //
  // One capture per request, stashed on the context and reused by the handler below.
  // Two captures would look correct and silently drop the gate headers: the health
  // route's own `content-type` would survive while `Vary` and
  // `Access-Control-Allow-Origin` from gate 1 vanished with the middleware's capture.
  //
  // The ctx here mirrors the legacy dispatcher's `{cid, cs, pathname}` so route
  // handlers — which read `ctx.cs`, `ctx.pathname`, `ctx.cid` — keep working without
  // being touched. Computed before the gate chain runs because a gate that answers
  // (CORS / auth) does not need it, but the handlers after a pass-through do.
  app.use("*", async (c, next) => {
    const capture = createResponseCapture();
    c.set(CAPTURE_KEY, capture);
    const incoming = c.env.incoming;
    const cid = getCidFromReq(incoming);
    const cs = getClient(cid);
    const pathname = new URL(c.req.url).pathname;
    c.set(CTX_KEY, { cid, cs, pathname });
    if (runGates(incoming, capture, pathname)) return responseFromCapture(c, capture);
    await next();
  });

  // ----- Health -----
  app.get("/api/health", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), healthRoute.handleHealth),
  );

  // ----- State snapshot -----
  // Companion SSE channel stays on the legacy dispatcher (see header comment).
  app.get("/api/state", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), stateRoute.handleState),
  );

  // ----- Sessions (list/create/switch/search/cleanup) -----
  app.get("/api/sessions", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleListSessions),
  );
  app.post("/api/sessions", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleNewSession),
  );
  app.post("/api/sessions/switch", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleSwitchSession),
  );
  app.post("/api/sessions/rename", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleRenameSession),
  );
  app.get("/api/sessions/search", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleSearchSessions),
  );
  app.post("/api/sessions/cleanup-orphans", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleCleanupOrphans),
  );
  app.delete("/api/sessions/:id", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleDeleteSession),
  );

  // ----- Sidebar session tree (mcode runtime db) -----
  app.get("/api/session-tree", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleSessionTree),
  );

  // ----- ACP session list + title helpers -----
  app.get("/api/acp-sessions", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleAcpSessions),
  );
  app.get("/api/acp-session-title", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), sessionsRoute.handleAcpSessionTitle),
  );

  // ----- Session export (Markdown / JSON) -----
  // `:id` is Hono's parameter marker; the handler resolves it from
  // ctx.pathname via slice + replace (same as the legacy router did).
  app.get("/api/sessions/:id/export", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), exportRoute.handleExport),
  );

  // ----- Chat -----
  // POST /api/send is fire-and-forget — the response is an ack, the actual
  // chat output flows back over the /api/events SSE channel.
  app.post("/api/send", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), chatRoute.handleSend),
  );
  app.post("/api/stop", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), chatRoute.handleStop),
  );
  app.post("/api/cmd", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), chatRoute.handleCmd),
  );

  // ----- Usage / quota -----
  // /api/usage and /api/usage-trigger share one handler in the legacy table;
  // register both paths in Hono so the legacy alias keeps working.
  app.post("/api/usage", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), usageRoute.handleUsage),
  );
  app.post("/api/usage-trigger", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), usageRoute.handleUsage),
  );
  app.get("/api/usage-real", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), usageRoute.handleUsageReal),
  );
  app.post("/api/refresh", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), usageRoute.handleRefresh),
  );
  app.get("/api/usage/forecast", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), usageRoute.handleForecast),
  );

  // ----- Workspace -----
  app.post("/api/workspace", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), workspaceRoute.handleWorkspace),
  );
  app.get("/api/workspace/browse", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), workspaceRoute.handleWorkspaceBrowse),
  );
  app.get("/api/workspace/tree", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), workspaceRoute.handleWorkspaceTree),
  );
  app.get("/api/workspace/resolve", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), workspaceRoute.handleWorkspaceResolve),
  );
  app.get("/api/workspace/recent", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), workspaceRoute.handleWorkspaceRecent),
  );
  app.post("/api/workspace/pick", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), workspaceRoute.handleWorkspacePick),
  );

  // ----- Native-style fs picker -----
  app.get("/api/fs/read", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), fsRoute.handleFsRead),
  );
  app.post("/api/fs/mkdir", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), fsRoute.handleFsMkdir),
  );

  // ----- Settings -----
  app.get("/api/settings", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), settingsRoute.handleGetSettings),
  );
  app.post("/api/settings", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), settingsRoute.handlePostSettings),
  );

  // ----- Authorize gate close path (B03) -----
  app.post("/api/auth/decision", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), authorizeRoute.handleAuthDecision),
  );

  // ----- Multipart file upload -----
  // The upload handler reads `req` directly (streaming multipart parser in
  // lib/upload.js). createResponseCapture never touches the request body,
  // so the raw Node stream is intact for the handler.
  app.post("/api/upload", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), uploadRoute.handleUpload),
  );

  // ----- Model + permission modes -----
  app.get("/api/models", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), modelRoute.handleGetModels),
  );
  app.post("/api/set-model", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), modelRoute.handleSetModel),
  );
  app.post("/api/permissions", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), modelRoute.handleSetPermissions),
  );
  app.get("/api/permissions-modes", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), modelRoute.handleListPermissionModes),
  );
  app.post("/api/answer", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), modelRoute.handleAnswer),
  );

  // ----- Debug injection (gated by DEBUG_INJECT=1) -----
  app.post("/api/debug/inject", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), debugRoute.handleDebugInject),
  );
  app.get("/api/debug/state", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), debugRoute.handleDebugState),
  );

  // ----- mcode acp protocol RPC -----
  app.post("/api/protocol/set-mode", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleSetMode),
  );
  app.post("/api/protocol/set-config-option", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleSetConfigOption),
  );
  app.post("/api/protocol/cancel", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleCancel),
  );
  app.post("/api/protocol/load-session", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleLoadSession),
  );
  app.post("/api/protocol/activate-session", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleActivateSession),
  );
  app.get("/api/protocol/list-sessions", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleListSessions),
  );
  app.get("/api/protocol/capabilities", (c) =>
    invokeHandler(c, c.get(CAPTURE_KEY), protocolRoute.handleCapabilities),
  );

  return app;
}

/** A Node `(req, res)` listener for the routes Hono owns. */
export function createHonoListener() {
  return getRequestListener(createHonoApp().fetch);
}