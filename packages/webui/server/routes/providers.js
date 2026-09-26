// webui/server/routes/providers.js
// GET /api/providers, PUT /api/providers, POST /api/providers/test
//
// Provider configuration v2 — the management surface behind the
// schema and layered-resolution contract in
// `lib/providers-config.js`. The three routes:
//
//   GET  /api/providers      — full (masked) catalogue + resolved
//                               layers + sources.
//   PUT  /api/providers      — validate + persist to user-level
//                               file + reload + SSE broadcast.
//   POST /api/providers/test — local key format check first, then a
//                               protocol-minimal connectivity probe.
//
// Security contract (pinned by tests):
//   - apiKey is masked in EVERY response path. The public shape is
//     `auth: { type, hasKey, apiKeyMasked, baseURL }`. The route
//     never returns the plaintext key, the masked form is the ONLY
//     shape an apiKey can take on the wire.
//   - The PUT handler writes the user-level file via atomic
//     rename; the env / cwd layers are deployment-owned and never
//     written by this handler.
//   - The probe handler rejects malformed keys locally — no network
//     call is made when `validateKeyFormat` returns `{ ok: false }`.
//   - Probe requests send the apiKey ONLY to the configured
//     baseURL; a structured error is returned when no baseURL is
//     configured for the protocol.
//
// Hot-reload semantics:
//   - PUT triggers `pushProvidersUpdated()`, which broadcasts a
//     named `providers.updated` SSE event with the masked payload
//     so the UI can refresh its catalogue without an extra round
//     trip. The next `GET /api/models` reads the same layers and
//     picks up the change immediately (the user-level file is
//     re-read on every call — no in-process cache to invalidate).

import { Readable } from "node:stream";

import {
  loadProvidersConfig,
  publicView,
  writeProvidersConfig,
  testProvider as runProbe,
  getUserLevelPath,
  applyKeepKeyConvention,
  loadUserLevelProviders,
} from "../lib/providers-config.js";
import { pushStateFor, sseByCid } from "../lib/state-bus.js";
import { readJson } from "../lib/read-json.js";

/**
 * GET /api/providers — masked catalogue + resolved-layer summary.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     version: 2,
 *     providers: [publicView(...)],
 *     sources: { env, cwd, user },   // absolute paths (env is the
 *                                    // MCODE_WEBUI_MODELS_CONFIG
 *                                    // override or null)
 *     userPath: "..."                // user-level file path
 *   }
 *
 * `sources` is documented (not redacted) — operators need to see
 * which file the server actually read.
 */
export function handleGetProviders(_req, res, _ctx) {
  const cfg = loadProvidersConfig();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      version: cfg.version,
      providers: cfg.providers.map(publicView),
      sources: cfg.sources,
      userPath: getUserLevelPath(),
    }),
  );
}

/**
 * PUT /api/providers — validate-and-persist to user-level file.
 *
 * Body shape (v2):
 *   { version: 2, providers: [ { id, label, protocol, auth, models, ... } ] }
 *
 * Behaviour:
 *   - 400 + structured error when any provider fails validation.
 *   - 500 + structured error when the atomic write fails.
 *   - 200 + the masked response on success.
 *   - Always broadcasts `providers.updated` after a successful write
 *     so every connected SSE client refreshes its catalogue.
 *
 * The body size is bounded by `lib/read-json.js` (the shared body
 * reader); a too-large payload is answered by the Hono capture with
 * 413 — same answer every other route returns.
 */
export async function handlePutProviders(req, res, _ctx) {
  const parsed = await readJson(req);
  if (!parsed || typeof parsed !== "object") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: "BAD_BODY", error: "body must be a JSON object" }),
    );
  }
  // Keep-existing-key convention (ticket 03 cross-branch API note):
//   `auth.apiKey` empty OR absent on an incoming provider means "don't
//   change the existing key". We copy the user-level file's apiKey
//   onto those records before validation, so the masked placeholder
//   the UI sends back (and an absent-field body) does not silently
//   wipe the plaintext on every edit. See
//   lib/providers-config.js#applyKeepKeyConvention.
//
// Layer scope: the "previous key" lookup reads the user-level file
// ONLY (`loadUserLevelProviders`), not the merged catalogue. Without
// this scoping, editing a provider whose key is sourced from the env
// or cwd layer would materialise the deployment secret into the
// user-level file — once written there, the deployment layer can no
// longer rotate it. The merged view still wins for the engine
// (`loadProvidersConfig` priority order), so the visible behaviour
// for the operator is unchanged: an env-defined key still wins at
// read time even after the user edits the provider.
//
// Only applied when `parsed.providers` is actually an array — a missing
// or non-array providers list is an error the original validation
// surfaces as BAD_BODY, and we must not change that behaviour.
const incomingProviders = Array.isArray(parsed.providers) ? parsed.providers : null;
const toWrite =
  incomingProviders === null
    ? parsed
    : {
        ...parsed,
        providers: applyKeepKeyConvention(loadUserLevelProviders(), incomingProviders),
      };
const result = writeProvidersConfig(toWrite);
  if (!result.ok) {
    const status = result.code === "WRITE_FAILED" ? 500 : 400;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: result.code, error: result.error }),
    );
  }
  // Reload + broadcast. `loadProvidersConfig()` re-reads the file on
  // every call (no in-process cache), so a follow-up GET already
  // sees the change. The SSE push is the mechanism the UI uses to
  // notice WITHOUT polling.
  pushProvidersUpdated();
  // The state-bus push keeps the existing snapshot contract intact
  // (UI's general "refresh from /api/state" hint) — model selectors
  // also re-fetch /api/models because the broadcast carries the
  // masked providers in `event: providers.updated`.
  pushStateFor("__broadcast__");
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      providers: result.providers.map(publicView),
      path: result.path,
    }),
  );
}

/**
 * POST /api/providers/test — per-protocol minimal connectivity
 * probe.
 *
 * Body shape:
 *   { protocol: "openai|anthropic|gemini", auth: { type, apiKey, baseURL } }
 *
 * Order of checks:
 *   1. protocol whitelist (no network for unknown protocols).
 *   2. local key format (no network for malformed keys).
 *   3. fetch with the configured baseURL (or the protocol default).
 *
 * `baseURL` in the request body is honoured so a UI "test this
 * endpoint" button can exercise a custom URL without going through
 * the persisted config.
 */
export async function handleTestProvider(req, res, _ctx) {
  const parsed = await readJson(req);
  if (!parsed || typeof parsed !== "object") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: "BAD_BODY", error: "body must be a JSON object" }),
    );
  }
  const protocol = typeof parsed.protocol === "string" ? parsed.protocol : "";
  const authRaw = parsed.auth && typeof parsed.auth === "object" ? parsed.auth : {};
  // The request body's `baseURL` (when provided) is the probe
  // target; persisted auth.baseURL is the fallback. Tests pass a
  // fake URL to confirm structured errors without a real network
  // call.
  const auth = {
    type: typeof authRaw.type === "string" ? authRaw.type : "byok",
    apiKey: typeof authRaw.apiKey === "string" ? authRaw.apiKey : "",
    baseURL: typeof authRaw.baseURL === "string" ? authRaw.baseURL : "",
  };
  // Optional timeout override (ms) — surfaces from the request
  // body so a UI "quick test" can fire a short probe. Unspecified
  // defaults to the lib's 8s.
  const timeoutMs =
    typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0
      ? Math.min(parsed.timeoutMs, 8000)
      : undefined;
  const result = await runProbe({ protocol, auth, timeoutMs });
  const status = result.ok
    ? 200
    : result.code === "BAD_PROTOCOL" || result.code === "INVALID_KEY"
      ? 400
      : 502;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: result.ok,
      protocol,
      code: result.code || (result.ok ? "OK" : "PROBE_FAILED"),
      error: result.error,
      latencyMs: result.latencyMs,
      detail: result.detail,
    }),
  );
}

// ---------------------------------------------------------------------
// SSE broadcast — the named event every connected client receives
// after a PUT (so the UI can refresh the catalogue without polling).
// The frame carries the masked providers payload; apiKey NEVER
// appears in cleartext (publicView is the only serialiser on this
// path, by design).
// ---------------------------------------------------------------------

function pushProvidersUpdated() {
  const cfg = loadProvidersConfig();
  const frame = `event: providers.updated\ndata: ${JSON.stringify({
    version: cfg.version,
    providers: cfg.providers.map(publicView),
  })}\n\n`;
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}

/**
 * Test-only helper: returns the SSE frame that would be emitted on
 * PUT, without writing to any client. Used by tests that want to
 * assert the masked shape directly.
 */
export function _peekProvidersUpdatedFrame() {
  const cfg = loadProvidersConfig();
  return `event: providers.updated\ndata: ${JSON.stringify({
    version: cfg.version,
    providers: cfg.providers.map(publicView),
  })}\n\n`;
}

/**
 * Test-only helper: returns the raw response stream shape used by
 * the test endpoint when it builds a fake request body.
 */
export function _bodyReadable(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}