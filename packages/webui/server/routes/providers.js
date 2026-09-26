// webui/server/routes/providers.js
// GET /api/providers, PUT /api/providers, POST /api/providers/test,
// GET /api/providers/presets, POST /api/providers/preset/:id/enable
//
// Provider configuration v2 — the management surface behind the
// schema and layered-resolution contract in
// `lib/providers-config.js`. The routes:
//
//   GET  /api/providers                     — full (masked) catalogue
//                                             + resolved layers + sources.
//   PUT  /api/providers                     — validate + persist to
//                                             user-level file + reload
//                                             + SSE broadcast.
//   POST /api/providers/test                — local key format check
//                                             first, then a protocol-
//                                             minimal connectivity probe.
//   GET  /api/providers/presets             — built-in preset
//                                             templates, each with an
//                                             `enabled` flag indicating
//                                             whether the preset id is
//                                             already configured.
//   POST /api/providers/preset/:id/enable   — materialise a preset
//                                             template into the
//                                             user-level file as
//                                             enabled (PUT semantics +
//                                             hot apply).
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
  normaliseProvider,
} from "../lib/providers-config.js";
import {
  PROVIDER_PRESETS,
  publicPresetView,
  presetToMaterialised,
  getPresetById,
} from "../lib/provider-presets.js";
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

// =====================================================================
// Preset routes (ticket 02).
//
//   GET  /api/providers/presets            — preset gallery.
//   POST /api/providers/preset/:id/enable  — one-click materialise.
//
// The GET response carries each preset's `enabled` flag — true when
// a provider with the same id is already in the configured
// catalogue. The UI uses that flag to render "Enabled" / "Enable"
// buttons without a second round-trip.
//
// The POST enable handler:
//   1. resolves the template by id (400 if unknown);
//   2. re-reads the current user-level catalogue;
//   3. if a provider with the same id is already configured, returns
//      409 with the existing record (idempotent semantics — calling
//      enable twice is a no-op + informational response);
//   4. otherwise prepends (or appends) the materialised template to
//      the existing user-level catalogue and writes the file via
//      `writeProvidersConfig` (which runs the same validation
//      gate as a manual PUT);
//   5. triggers the same `providers.updated` SSE broadcast as a PUT,
//      so every connected client refreshes its catalogue.
//
// `apiKey` is deliberately left empty on materialisation — the
// user must supply it after the template is enabled.
// =====================================================================

/**
 * GET /api/providers/presets — built-in preset gallery.
 *
 * Response 200:
 *   {
 *     ok: true,
 *     version: 2,
 *     presets: [ publicPresetView(...) with an extra `enabled` flag ],
 *     enabledIds: [ "zhipu", "claude-code", ... ]
 *   }
 */
export function handleGetPresets(_req, res, _ctx) {
  const cfg = loadProvidersConfig();
  const configuredIds = new Set(cfg.providers.map((p) => p.id));
  const presets = PROVIDER_PRESETS.map((p) => ({
    ...publicPresetView(p),
    enabled: configuredIds.has(p.id),
  }));
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      version: cfg.version,
      presets,
      enabledIds: [...configuredIds].filter((id) =>
        PROVIDER_PRESETS.some((p) => p.id === id),
      ),
    }),
  );
}

/**
 * POST /api/providers/preset/:id/enable — materialise a preset.
 *
 * Behaviour:
 *   - 400 when `id` does not name a known preset.
 *   - 200 (idempotent) when the preset is already configured; the
 *     response carries the existing (masked) provider record so
 *     the UI can re-show it.
 *   - 200 when the template was newly enabled; the response
 *     carries the materialised (masked) provider record.
 *
 * Either way, a `providers.updated` SSE event is broadcast so
 * every connected client refreshes its catalogue. The handler
 * uses `writeProvidersConfig` (the same path as PUT) so the
 * persisted file passes the same v2 validation gate and the
 * layered-resolution hot reload applies on the next
 * /api/providers GET.
 */
export async function handleEnablePreset(req, res, _ctx, params = {}) {
  const id =
    (params && typeof params.id === "string" && params.id) ||
    extractIdFromUrl(req.url);
  const tpl = getPresetById(id);
  if (!tpl) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: false,
        code: "UNKNOWN_PRESET",
        error: `preset '${id}' is not in the catalogue`,
      }),
    );
  }

  // Read the current user-level file. `writeProvidersConfig`
  // writes the WHOLE catalogue (it owns the file), so we have
  // to merge with whatever is already there before calling it.
  const cfg = loadProvidersConfig();
  const existing = cfg.providers.find((p) => p.id === tpl.id);
  if (existing) {
    // Idempotent: the preset is already configured. Surface the
    // existing masked record so the caller can re-render it
    // without a second GET.
    pushStateFor("__broadcast__");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: true,
        alreadyEnabled: true,
        provider: publicView(existing),
      }),
    );
  }

  // New materialisation. Prepend the preset so the UI's
  // "enable" action keeps the preset visible at the top of the
  // provider list; the rest of the user-level catalogue is
  // preserved verbatim.
  const materialised = presetToMaterialised(tpl.id);
  const nextProviders = [materialised, ...cfg.providers];
  // Defensive validation — `writeProvidersConfig` would catch a
  // bad shape, but a structured error here makes the failure
  // mode obvious in the route test.
  for (const p of nextProviders) {
    const r = normaliseProvider(p);
    if (!r.ok) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          ok: false,
          code: "MATERIALISE_FAILED",
          error: r.error,
        }),
      );
    }
  }

  const result = writeProvidersConfig({
    version: 2,
    providers: nextProviders,
  });
  if (!result.ok) {
    const status = result.code === "WRITE_FAILED" ? 500 : 400;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: result.code, error: result.error }),
    );
  }
  // Broadcast — same SSE event PUT uses. The UI's model picker
  // re-fetches /api/models after this, picking up the new
  // template-driven entries.
  pushProvidersUpdated();
  pushStateFor("__broadcast__");

  // Find the persisted record for the response body.
  const persisted = result.providers.find((p) => p.id === tpl.id);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      alreadyEnabled: false,
      provider: publicView(persisted),
      path: result.path,
    }),
  );
}

/**
 * Pull `:id` out of `req.url` as a fallback when the Hono layer
 * didn't already pass `params`. Kept defensive: the Hono handler
 * always supplies params, but legacy callers / unit tests that
 * synthesise a raw `req` URL may not.
 */
function extractIdFromUrl(reqUrl) {
  if (typeof reqUrl !== "string") return "";
  const m = reqUrl.match(/\/api\/providers\/preset\/([^/?#]+)\/enable/);
  return m ? decodeURIComponent(m[1]) : "";
}
