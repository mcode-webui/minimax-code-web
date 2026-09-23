// mcode-webui request gate chain.
//
// These are the five security gates that used to sit inline at the top of
// `router.js#handleRequest`. They moved here verbatim so that a second HTTP layer can
// run the *same* chain instead of a re-implementation. That matters more than the
// tidiness: these are the origin/CSRF boundary, the LAN reject, token auth, the rate
// limiter and read-only mode, and two copies of a security boundary drift.
//
// Order is load-bearing:
//   1.  CORS headers — reflect only origins we actually serve.
//   1b. Browser Origin/CSRF boundary — a mutating request carrying an untrusted Origin
//       is 403'd BEFORE the token gate and WITHOUT the local-request exemption, which
//       is the whole point: a malicious page hitting 127.0.0.1 is "local" by socket.
//   2.  LAN reject — non-local request while LAN sharing is off.
//   3.  Token auth — `/api/*` when a token is configured (local requests exempt).
//   4.  Rate limit — per {IP,token}; `/api/health`, OPTIONS and loopback exempt.
//   5.  Read-only mode — non-GET from a non-local caller.
//
// `runGates` returns true when a gate has already written the response and the caller
// must stop. It is synchronous by construction: every gate answers from in-memory
// state, so there is no await point at which a request could be half-gated.

import { getServingPort } from "./config.js";
import { isLocalRequest, buildTrustedOrigins, normalizeOriginHeader } from "./lan.js";
import { getLanBroadcast, getReadOnly, getTrustedOrigins, rejectLan } from "./settings.js";
import { isRequestAuthorized, writeAuthRequired } from "./auth.js";
import { rateLimitMiddleware } from "./rate-limit.js";

// Moved here together with gate 5; it was a private helper in router.js and is used
// nowhere else.
function rejectReadOnly(res, _pathname) {
  if (!res.headersSent) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "read-only mode" }));
  }
  return true;
}

/**
 * Run gates 1 → 5 in order.
 *
 * @returns {boolean} true when a gate has answered the request and the caller must stop.
 */
export function runGates(req, res, pathname) {
  // Gate 1: CORS headers (trusted-origin reflection, v2 security fix —
  //   PR #55 review point 1).
  //   Was: an unconditional `Access-Control-Allow-Origin: *` on every
  //   response. Combined with the local-request token bypass
  //   (auth.js#isRequestAuthorized → lan.js#isLocalRequest) that let
  //   ANY web page read API responses by simply targeting
  //   http://127.0.0.1:<port> — the browser dialed loopback, the server
  //   saw a "local" socket, and the wildcard let the page read the
  //   body (incl. GET /api/settings' token-bearing share URL).
  //   Now: only origins we actually serve — loopback/localhost (+ the
  //   LAN address while LAN sharing is on) — plus the explicit
  //   trustedOrigins allowlist from settings get CORS headers, and the
  //   caller's own Origin is reflected verbatim, never a wildcard.
  //   Untrusted origins receive NO Access-Control-* headers on ANY
  //   response, including the OPTIONS preflight short-circuit below
  //   (preflight and actual response stay consistent), so browsers
  //   cannot read the body even though the request itself may execute.
  //   Clients that send no Origin header (curl, MCP, CLI, tests) get
  //   no CORS headers — they never needed them; zero regression.
  const originHeader = normalizeOriginHeader(req.headers.origin);
  const trustedOrigins = buildTrustedOrigins({
    port: getServingPort(),
    lanBroadcast: getLanBroadcast(),
    extra: getTrustedOrigins(),
  });
  const originTrusted = originHeader !== "" && trustedOrigins.has(originHeader);
  // The response varies by request Origin whether or not this branch
  // reflects — caches must key on it either way.
  res.setHeader("Vary", "Origin");
  if (originTrusted) {
    res.setHeader("Access-Control-Allow-Origin", originHeader);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  // Gate 1b: browser Origin / CSRF boundary (v2 security fix — PR #55
  //   review point 1, the second half of the wildcard × local-bypass
  //   hole). Browsers attach an Origin header to non-GET requests
  //   (same- and cross-origin alike). If one is present and is NOT in
  //   the trusted set, the mutating request dies here with 403 —
  //   BEFORE the token gate, and CRUCIALLY without the local-request
  //   exemption: a malicious page targeting 127.0.0.1 arrives from a
  //   loopback socket, is "local", would bypass the token — and is
  //   still rejected, because its Origin is not ours. Origin-less
  //   clients (curl / MCP / CLI) pass through unchanged.
  if (
    originHeader !== "" &&
    !originTrusted &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS"
  ) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: false,
      error: "cross-origin request rejected",
    }));
    return true;
  }

  const local = isLocalRequest(req);

  // Gate 2: LAN reject (only for non-local requests; /api/settings is the exception that lets users turn LAN back on)
  if (!local && !getLanBroadcast()) {
    if (rejectLan(res, pathname, req.socket.remoteAddress, req.headers["accept-language"])) return;
  }

  // Gate 3: token auth (v1.0.1).
  //   - Local request: always allowed.
  //   - /api/* routes (incl. SSE /api/events): gated when TOKEN auth enabled.
  //   - OPTIONS preflight: always allowed (browsers cannot attach
  //     Authorization to a preflight; CORS spec says server must respond
  //     to OPTIONS with the negotiated CORS headers, not 401).
  //     The OPTIONS short-circuit further down returns 204 with the
  //     CORS headers set here in Gate 1.
  //   - Static files (HTML/CSS/JS/images): always public so the SPA can
  //     bootstrap.
  //   - The SPA reads ?token= from the URL (browser) and stores it in
  //     localStorage; subsequent fetch + EventSource attach it as
  //     Authorization: Bearer / ?token=.
  if (
    pathname.startsWith("/api/") &&
    req.method !== "OPTIONS" &&
    !isRequestAuthorized(req) &&
    writeAuthRequired(res)
  ) {
    return true;
  }

  // Gate 4: rate limit (v2.0, lease C03).
  //   - Loopback requests bypass entirely (isLocalRequest).
  //   - `/` and `/api/health` are never throttled — health must answer
  //     for orchestrators (k8s liveness probes), and `/` is a static
  //     file that goes through serveStatic, not the /api/* tree.
  //   - OPTIONS preflight bypasses so cross-origin clients can complete
  //     their handshake before they hit the limiter.
  //   - Token holders get 2x budget (see rate-limit.js); the multiplier
  //     is transparent here — we just call middleware().
  if (
    !local &&
    pathname.startsWith("/api/") &&
    pathname !== "/api/health" &&
    req.method !== "OPTIONS" &&
    req.method !== "HEAD"
  ) {
    const rl = rateLimitMiddleware(req, res);
    if (rl.blocked) {
      if (!res.headersSent) {
        res.writeHead(rl.status || 429, rl.headers || {});
        res.end(JSON.stringify(rl.body));
      }
      return true;
    }
  }

  // Gate 5: read-only mode (v1.0.1)
  //   - Local request: always allowed (admin should never get locked out)
  //   - OPTIONS preflight: always allowed
  //   - Non-GET (POST/PUT/DELETE): 403
  //   - /api/settings: allowed (so the user can flip the switch back off)
  if (
    !local &&
    pathname.startsWith("/api/") &&
    pathname !== "/api/settings" &&
    req.method !== "GET" &&
    req.method !== "OPTIONS" &&
    req.method !== "HEAD" &&
    getReadOnly() &&
    rejectReadOnly(res, pathname)
  ) {
    return true;
  }

  return false;
}
