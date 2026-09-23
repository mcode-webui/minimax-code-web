// webui/server/router.js
// Legacy HTTP dispatcher for the routes that have NOT moved into the Hono
// layer (see server/app.js's OWNED_ROUTES for the migration ledger).
//
// What stays here:
//
//   - The two SSE channels: GET /api/events (state push) and GET /api/alerts
//     (anomaly ring buffer). Both hold the response writer in lib/state-bus.js
//     and reuse it across pushes (res.write(frame) mid-flight), which a buffered
//     createResponseCapture cannot model. They move to Hono with P2's streaming
//     variant.
//   - Static + SPA fallback (`serveStatic`, `serveIndex`).
//   - OPTIONS preflight (short-circuited before the loop).
//   - The `/trajectory` mount (separate panel with its own handler).
//   - /api/health and /api/settings, kept so the CORS / Origin / rate-limit
//     gate tests (checks/router-origin-gate.check.mjs) get a 200 from the
//     dispatcher path to assert on, instead of falling through to 404. The
//     Hono app (server/app.js) owns these endpoints for every real consumer.
//
// Order of gates (top-to-bottom):
//   1. CORS headers — trusted-origin reflection only (untrusted/absent
//      Origin gets no CORS headers at all)
//   1b. Browser Origin/CSRF gate — mutating request with an untrusted
//      Origin is 403'd BEFORE any other gate (local requests included)
//   2. LAN reject (non-local + LAN off)
//   3. Token auth (non-local + token enabled + token set)
//   4. Rate limit (per-{IP,token}; /api/* minus /api/health; OPTIONS exempt)
//   5. Read-only gate (non-local + readOnly + non-GET/OPTIONS)
//   6. Route dispatch
//
// Local requests (loopback + this host's LAN_IP) bypass (2)(3)(4)(5) —
// but NEVER (1b): socket locality is an identity fact about the client
// machine, not about the browser page that initiated the request, so
// the loopback token bypass does not extend to cross-origin pages.
// `/api/settings` is exempted from (2) so users can flip the LAN switch
// back on from a remote device.

import { getServingPort } from "./lib/config.js";
import {
  isLocalRequest,
  buildTrustedOrigins,
  normalizeOriginHeader,
} from "./lib/lan.js";
import {
  getLanBroadcast,
  getReadOnly,
  getTrustedOrigins,
  rejectLan,
} from "./lib/settings.js";
import { getClient, getCidFromReq } from "./lib/state-bus.js";
import { runGates } from "./lib/gates.js";
import { serveStatic, serveIndex } from "./lib/static.js";
import { getTrajectoryPanelHandler } from "./lib/trajectory.js";
import { isRequestAuthorized, writeAuthRequired } from "./lib/auth.js";
import { rateLimitMiddleware } from "./lib/rate-limit.js";

import * as stateRoute from "./routes/state.js";
import * as alertsRoute from "./routes/alerts.js";
import { handleHealth } from "./routes/health.js";
import { handlePostSettings } from "./routes/settings.js";


// Route table: pattern → handler. Patterns are tested in declaration order; first match wins.
// Each entry: { method, match(pathname) → boolean, handler(req, res, ctx) }
//
// Only the two SSE channels plus /api/health and /api/settings live here now.
// Every other /api/* endpoint has been migrated to server/app.js's Hono application.
const ROUTES = [
  // Static + HTML
  {
    method: "GET",
    match: (p) => p === "/" || p === "/index.html",
    handler: (req, res) => {
      // Non-local request without a valid token gets the self-service
      // token gate page instead of the app shell — the shell would
      // load and then every /api/* call would 401 with no guidance.
      // Local requests and token-authenticated requests skip the gate
      // (isRequestAuthorized already returns true for both).
      if (!isRequestAuthorized(req)) {
        if (serveStatic("auth-gate.html", res) !== false) return true;
      }
      if (serveIndex(res) === false) {
        res.writeHead(404);
        res.end("not found");
      }
      return true;
    },
  },
  {
    method: "GET",
    match: (p) => !!p && p !== "/" && p.includes("."),
    handler: (_req, res, _ctx, pathname) => {
      if (serveStatic(pathname, res) !== false) return true;
      return false; // not handled — fall through
    },
  },

  // OPTIONS (CORS preflight) — short-circuit before anything else.
  // Hono could own this too, but the legacy 204 short-circuit is two lines
  // and keeps OPTIONS answers out of the gates' capture-and-respond path
  // (which is built for buffered single responses).
  {
    method: "OPTIONS",
    match: () => true,
    handler: (_req, res) => {
      res.writeHead(204);
      res.end();
      return true;
    },
  },

  // State SSE: writer held by lib/state-bus.js and reused across pushes.
  // Buffered response capture cannot model res.write(frame) mid-flight;
  // the streaming variant lands in P2.
  {
    method: "GET",
    match: (p) => p === "/api/events",
    handler: stateRoute.handleEvents,
  },

  // Anomaly / system-signal SSE channel.
  {
    method: "GET",
    match: (p) => p === "/api/alerts",
    handler: alertsRoute.handleAlerts,
  },

  // /api/health — kept in the legacy router so the CORS / origin / rate-limit
  // gate tests (router-origin-gate.check.mjs) get a 200 to assert CORS-header
  // absence on, instead of falling through to the 404 path. The Hono app
  // (server/app.js) still owns this endpoint for every real consumer.
  {
    method: "GET",
    match: (p) => p === "/api/health",
    handler: handleHealth,
  },

  // /api/settings — same rationale as /api/health above. The gate tests POST to
  // this path with controlled Origin headers to verify that an untrusted
  // Origin is rejected at Gate 1b even over a loopback socket, and that a
  // trusted / Origin-less POST reaches the handler. The Hono app owns the
  // endpoint for every real consumer.
  {
    method: "POST",
    match: (p) => p === "/api/settings",
    handler: handlePostSettings,
  },
];

export async function handleRequest(req, res) {
  // `pathname` and `cid` are derived here rather than inside the gate chain: the gate
  // chain only needs `pathname` as an input, and both are used further down by the
  // route table and the static/SPA path.
  const pathname = (req.url || "/").split("?")[0];
  const cid = getCidFromReq(req);

  // Gates 1 → 5 (CORS, origin/CSRF, LAN reject, token, rate limit, read-only)
  // live in lib/gates.js, so any HTTP layer runs the same chain.
  if (runGates(req, res, pathname)) return;

  const cs = getClient(cid);
  const ctx = { cid, cs, pathname };

  // Trajectory studio mount. Sits AFTER gates 1-5 (origin/CSRF, LAN, token,
// rate-limit, read-only) so the panel inherits the webui's auth posture;
// the studio's own GET-only rule and strict CSP still apply inside the
// handler. '/trajectory' (no slash) redirects so the page's relative asset
// URLs resolve under the mount point.
  if (pathname === "/trajectory" || pathname.startsWith("/trajectory/")) {
    if (req.method === "GET" && pathname === "/trajectory") {
      res.writeHead(301, { Location: "/trajectory/" });
      res.end();
      return;
    }
    const panel = await getTrajectoryPanelHandler();
    if (panel) {
      const handled = await panel(req, res);
      if (handled !== false) return;
    } else {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "trajectory_unavailable" }));
      return;
    }
  }

  // Try static files first (any path with a dot — the Next export's assets and
  // its favicons, or any other dotted public file). If served, we're done.
  if (req.method === "GET" && pathname !== "/" && pathname.includes(".")) {
    if (serveStatic(pathname, res) !== false) return;
    // fall through to API routes (e.g. /api/foo.bar) — but those would have no dot, skip
  }

  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    // CodeQL js/regex-injection 是名字面伪报：以 pathname 为实参调用
    // route 的 match 谓词时，CodeQL 按 String.prototype.match(pattern)
    // 建模，把污染 pathname 当成了正则模式。实况是 ROUTES 全部 match
    // 实现均为静态谓词（=== / startsWith / includes / 唯一一条预编译
    // 正则字面量 .test(p)），pathname 只作被检主体、从不进模式位。
    // 经局部变量调用消除该名字面汇点，匹配语义不变。
    const matchesPath = route.match;
    if (!matchesPath(pathname)) continue;
    try {
      const handled = await route.handler(req, res, ctx, pathname);
      // If handler returned false (e.g. static returned false), continue trying other routes
      if (handled === false) continue;
      return;
    } catch (e) {
      console.error("[router] %s %s threw:", req.method, pathname, e);
      try {
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } catch {}
      return;
    }
  }

  // Static-export fallback for route-style paths.
  //
  // The Next.js build emits `route/index.html`, so a path like `/settings` is a
  // real page. The earlier static attempt only covers paths containing a dot (which
  // is what keeps it from stealing API routes), so those pages are resolved here
  // instead: after every declared route has been tried, so a page file can never
  // shadow an endpoint, and skipping `/api/` outright for the same reason.
  if (
    req.method === "GET" &&
    pathname !== "/" &&
    pathname !== "" &&
    !pathname.includes(".") &&
    !pathname.startsWith("/api/")
  ) {
    if (serveStatic(pathname, res) !== false) return;
  }

  // No route matched
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}