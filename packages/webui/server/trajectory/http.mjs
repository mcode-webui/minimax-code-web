/**
 * Local Trajectory Studio web panel.
 *
 * Bound to `127.0.0.1` only — the address is a constant with no override, because
 * a configurable bind address is one environment variable away from publishing
 * every session's tool arguments to the network.
 *
 * Authorization is a per-process capability, not a fence. A Host check, an Origin
 * check and a fixed custom header are all cross-site request forgery defences:
 * they stop a *web page* from reaching the API and none of them stops a local
 * *process*, which can send any header it likes. Each start therefore mints a
 * random capability, hands it to the caller in the URL's fragment, and requires it
 * on every API route. The fragment never travels to the server, so the token stays
 * out of request logs, out of `Referer`, and out of any asset request.
 *
 * The capability lives in memory for the life of this process and nothing about
 * the panel is written to disk. That is also what keeps concurrent sessions apart:
 * mcode spawns one MCP server per session, so two sessions get two panels with two
 * capabilities, and one session's URL cannot open the other's panel.
 */

import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { redactPayload, redactPath, redactText } from './redact.mjs';
import { EGRESS_STRING_LIMIT } from './config.mjs';

// v2.1 (in-product migration): assets moved from plugin web/ to the webui
// package's public/trajectory/ (served by the standalone panel AND the mounted
// webui route from this single location).
const WEB_ROOT = new URL('../../public/trajectory/', import.meta.url);
const TOKEN_HEADER = 'x-trajectory-token';

/**
 * The only address the panel may listen on. Not configurable on purpose: an
 * environment variable here would be a one-character path to exposing every
 * session on the network.
 */
const LISTEN_ADDRESS = '127.0.0.1';

/** A peer address that is loopback, including the IPv4-mapped IPv6 form. */
function isLoopbackPeer(address) {
  if (typeof address !== 'string') return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || /^127\./u.test(address);
}

/** Constant-time capability comparison that tolerates any supplied shape. */
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  // A repeated header arrives as an array; refuse it rather than pick a winner.
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Fixed entry points. Everything else is refused. */
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]);

/**
 * The client is split into ES modules under `/js/`. Serve them by a narrow name
 * pattern rather than by enumerating files, so adding a module needs no change
 * here, while anything outside the pattern stays denied by default.
 */
const CLIENT_MODULE = /^\/js\/[a-z0-9-]+\.js$/;

function resolveStatic(pathname) {
  const mapped = STATIC_FILES.get(pathname);
  if (mapped) return mapped;
  if (CLIENT_MODULE.test(pathname)) return pathname.slice(1);
  return null;
}

/**
 * An error whose code is safe to send to the client.
 *
 * The code comes from a fixed set chosen by the server; it never contains text
 * derived from the request. An error string that embeds the request (a route, a
 * session id) is a reflection surface, and echoing an unexpected error's message
 * leaks internals — so anything that is not an ApiError is written to stderr and
 * reported to the client as a single generic code.
 */
class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

/* ----------------------------------------------------------------- studio -- */

export function createStudio({ store, homeDir }) {
  let server = null;
  let port = null;
  let token = null;
  let focusSessionId = null;

  async function start({ sessionId, port: requested } = {}) {
    if (sessionId) focusSessionId = sessionId;
    if (server && port) {
      // Reuse the running panel, capability included: minting a new one would
      // invalidate the URL the caller already has open.
      return { url: panelUrl(port, token), port, reused: true, sessionId: focusSessionId, boundTo: LISTEN_ADDRESS };
    }
    // 256 bits from the CSPRNG, minted per process and never derived from anything
    // an observer could read — not the pid, not PLUGIN_ROOT, not the port.
    if (!token) token = randomBytes(32).toString('base64url');

    const handler = createRequestHandler({
      store,
      homeDir,
      getFocus: () => focusSessionId,
      setFocus: (id) => { focusSessionId = id; },
      getToken: () => token,
    });
    server = http.createServer((req, res) => {
      handler(req, res).catch((error) => {
        // The detail goes to the operator's stderr, never into the response.
        process.stderr.write(`[trajectory-studio] ${error?.stack ?? String(error)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
        }
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
    });
    server.keepAliveTimeout = 5000;

    port = await listenOnFreePort(server, Number.isInteger(requested) ? requested : null);
    if (Number.isInteger(requested) && requested >= 1024 && port !== requested) {
      // Silently moving to another port hides the real problem: something else is
      // already serving the requested one, so the old panel keeps answering and the
      // reader is looking at stale code.
      process.stderr.write(
        `[trajectory-studio] port ${requested} is in use; listening on ${port} instead. ` +
        `Another instance is still serving ${requested}.\n`);
    }
    return { url: panelUrl(port, token), port, reused: false, sessionId: focusSessionId, boundTo: LISTEN_ADDRESS };
  }

  async function stop() {
    // The capability dies with the listener: a URL from a previous panel must not
    // come back to life when a later one reuses the port.
    token = null;
    if (!server) return false;
    const closing = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closing;
    server = null;
    port = null;
    return true;
  }

  return {
    start,
    stop,
    get status() {
      return { running: Boolean(server), port, sessionId: focusSessionId, boundTo: LISTEN_ADDRESS };
    },
  };
}

/**
 * The panel URL, with the capability in the fragment.
 *
 * A fragment rather than a query parameter on purpose: the browser never sends it
 * to the server, so it stays out of request logs and out of the `Referer` of any
 * asset request. The page reads it from `location.hash` and sends it as a header.
 */
function panelUrl(port, capability) {
  return `http://${LISTEN_ADDRESS}:${port}/#t=${capability}`;
}

function listenOnFreePort(server, preferred) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        server.listen(0, LISTEN_ADDRESS, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    const target = Number.isInteger(preferred) && preferred >= 1024 && preferred <= 65535 ? preferred : 0;
    server.listen(target, LISTEN_ADDRESS, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

/* ---------------------------------------------------------------- request -- */

export function createRequestHandler({
  store,
  homeDir,
  getFocus,
  setFocus,
  getToken = () => null,
  // v2.1 (in-product): `standalone: false` mounts the panel inside the webui
  // router. The webui's own gates (origin/CSRF, LAN reject, token auth, rate
  // limit, read-only) have already run for the request, and the listener is
  // the webui's own — so the standalone-only peer/Host/Origin/capability
  // checks are skipped, while method limits, CSP and redaction stay.
  standalone = true,
  // When mounted, the URL prefix that addresses this panel (e.g. '/trajectory').
  basePath = '',
} = {}) {
  const json = (res, value, status = 200) => {
    res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify(value));
  };
  const fail = (res, status, message) => json(res, { error: message }, status);

  return async function handle(req, res) {
    const authority = `${LISTEN_ADDRESS}:${req.socket.localPort}`;

    let url;
    if (standalone) {
      // First, before anything is read: the listener is bound loopback-only, so a
      // non-loopback peer means the socket was reached some other way.
      if (!isLoopbackPeer(req.socket.remoteAddress)) return fail(res, 403, 'forbidden_remote');
      const host = req.headers.host;
      if (host !== authority && host !== `localhost:${req.socket.localPort}`) {
        return fail(res, 403, 'forbidden_host');
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${authority}` && origin !== `http://localhost:${req.socket.localPort}`) {
        return fail(res, 403, 'forbidden_origin');
      }
      url = new URL(req.url, `http://${authority}`);
    } else {
      url = new URL(req.url, `http://${authority}`);
      const prefix = basePath.replace(/\/$/, '');
      if (prefix) {
        const p = url.pathname;
        if (p !== prefix && !p.startsWith(`${prefix}/`)) return false; // not ours
        url.pathname = p === prefix ? '/' : p.slice(prefix.length);
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');

    if (url.pathname.startsWith('/api/')) {
      // The capability. Without it the panel answers with nothing but the code, so
      // a local process that has not been handed the URL learns no session data.
      // (standalone mode only — when mounted, the webui's own token/origin gates
      // already decided this request.)
      if (standalone) {
        if (!tokenMatches(getToken(), req.headers[TOKEN_HEADER])) return fail(res, 403, 'forbidden_token');
        if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return fail(res, 403, 'cross_site');
      }
      try {
        const payload = await api(store, homeDir, url, { getFocus, setFocus });
        // One sweep at the boundary, on top of the per-field redaction each read
        // already applies, so a field added later cannot leave unredacted.
        return json(res, redactPayload(payload ?? { ok: true }, { maxLength: EGRESS_STRING_LIMIT }));
      } catch (error) {
        if (error instanceof ApiError) return fail(res, error.status, error.code);
        process.stderr.write(`[trajectory-studio] ${error?.stack ?? String(error)}\n`);
        return fail(res, 500, 'internal_error');
      }
    }

    const file = resolveStatic(url.pathname);
    if (!file) return fail(res, 404, 'not_found');
    try {
      const body = await readFile(new URL(file, WEB_ROOT));
      res.writeHead(200, securityHeaders({ 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' }));
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return fail(res, 500, 'static_unavailable');
    }
  };
}

/* -------------------------------------------------------------------- api -- */

async function api(store, homeDir, url, { getFocus, setFocus }) {
  const route = url.pathname;

  if (route === '/api/meta') {
    return {
      dataDir: store.dataDir,
      sqliteAvailable: Boolean(store.db),
      ftsAvailable: store.hasFts,
      readOnly: true,
      boundTo: LISTEN_ADDRESS,
      focusSessionId: getFocus() ?? null,
      warnings: store.warnings,
    };
  }

  if (route === '/api/sessions') {
    // A single-session lookup lets the sidebar force-include the session on screen
    // even when a limit or filter would have excluded it, so the highlight can never
    // disagree with the detail pane.
    const only = url.searchParams.get('id');
    const raw = only
      ? [store.getSession(only)].filter(Boolean)
      : store.listSessions({
          limit: Number(url.searchParams.get('limit')) || 50,
          agent: url.searchParams.get('agent') || undefined,
          kind: url.searchParams.get('kind') || undefined,
          includeArchived: url.searchParams.get('includeArchived') === '1',
        });
    const sessions = (await store.annotateWorkspaces(raw))
      .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) }));
    return { sessions };
  }

  if (route === '/api/agents') {
    // Agents differ per machine — sub-agent names come from whatever presets that
    // install has — so the filter's options are read from the data, not hard-coded.
    return { agents: store.listAgents() };
  }

  if (route === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const raw = store.searchSessions({ query, limit: Number(url.searchParams.get('limit')) || 50 });
    const sessions = (await store.annotateWorkspaces(raw))
      .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) }));
    // The query is not echoed: the client already has what it typed, and echoing a
    // request value back through the response body is a reflection surface.
    return { sessions };
  }

  if (route === '/api/overview') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) {
      const [latest] = store.listSessions({ limit: 1 });
      if (!latest) return { session: null, stats: null, events: [], tasks: [] };
      return overview(store, homeDir, latest.sessionId);
    }
    setFocus?.(sessionId);
    return overview(store, homeDir, sessionId);
  }

  if (route === '/api/timeline') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) throw new ApiError(400, 'session_required');
    return { points: store.getTimeline(sessionId) };
  }

  if (route === '/api/task-output') {
    const taskId = url.searchParams.get('taskId');
    if (!taskId) throw new ApiError(400, 'taskId_required');
    const maxBytes = Math.min(262144, Math.max(256, Number(url.searchParams.get('maxBytes')) || 16384));
    let output;
    try {
      output = await store.readTaskOutput(taskId, { maxBytes });
    } catch {
      // readTaskOutput validates the id against a strict shape; a rejection is a bad
      // request, not a server fault.
      throw new ApiError(400, 'invalid_task_id');
    }
    return { ...output, text: redactText(output.text, { maxLength: 262144 }) };
  }

  if (route === '/api/events') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) throw new ApiError(400, 'session_required');
    const detailLevel = url.searchParams.get('detailLevel') === 'full' ? 'full' : 'summary';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const turnId = url.searchParams.get('turnId') || undefined;
    let page = store.getEvents({ sessionId, offset, limit, detailLevel, turnId });
    if (page.events.length === 0 && page.source !== 'sqlite') {
      page = await store.readJsonlEvents({ sessionId, limit, detailLevel });
      page = { ...page, total: page.events.length, nextOffset: null };
    }
    const events = detailLevel === 'full'
      ? page.events.map((event) => redactPayload(event, { maxLength: 20000 }))
      : page.events;
    return {
      detailLevel,
      source: page.source,
      offset,
      total: page.total,
      nextOffset: page.nextOffset,
      events,
    };
  }

  // The route is deliberately absent from the message: it is request-controlled.
  throw new ApiError(404, 'unknown_route');
}

function overview(store, homeDir, sessionId) {
  const session = store.getSession(sessionId);
  if (!session) throw new ApiError(404, 'session_not_found');
  const stats = store.getStats(sessionId);
  const tasks = store.listBackgroundTasks(sessionId, { limit: 500 });
  const agent = store.getAgentDefinition(sessionId);
  // No events here on purpose: the client asks /api/events for the page it will
  // actually render. Fetching them here only to discard them was the single
  // largest waste in a session switch.
  return {
    session: { ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) },
    stats,
    turns: store.getTurnSummaries(sessionId),
    agent: agent
      ? { ...agent, systemPrompt: agent.systemPrompt ? redactText(agent.systemPrompt, { maxLength: 20000 }) : null }
      : null,
    tasks,
  };
}

export const STUDIO_STATIC_FILES = [...STATIC_FILES.keys()];
export const webRootPath = fileURLToPath(WEB_ROOT);
export const studioListenAddress = LISTEN_ADDRESS;
export const studioTokenHeader = TOKEN_HEADER;

/**
 * v2.1 (in-product): mount the panel inside the webui router at `basePath`.
 *
 * The returned handler answers requests under `basePath` (both `/trajectory`
 * and `/trajectory/...`) and returns `false` for anything else so the router
 * can fall through. Authorization is delegated to the webui's own gates
 * (origin/CSRF, LAN reject, token auth, rate limit, read-only), which have
 * already run by the time this handler is reached.
 */
export function createMountedPanelHandler({ store, homeDir, basePath = '/trajectory' }) {
  // Mounted sessions have no MCP-side focus concept; the client always names
  // the session it wants (or gets the latest). Keep the required callbacks.
  let mountedFocus = null;
  const handler = createRequestHandler({
    store,
    homeDir,
    standalone: false,
    basePath,
    getFocus: () => mountedFocus,
    setFocus: (id) => { mountedFocus = id; },
  });
  return async function mountedPanel(req, res) {
    return handler(req, res);
  };
}
