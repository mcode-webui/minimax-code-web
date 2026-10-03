// webui/server/routes/providers.js
// GET /api/providers, PUT /api/providers, POST /api/providers/test,
// GET /api/providers/presets, POST /api/providers/preset/:id/enable
//
// The provider management surface, and — since batch B11 — a THIN one.
// The endpoint contracts, the wire shapes, the masking rule, the SSE
// frame and the connectivity probe all live where they always did. The
// three things that moved out are the ones that were never really this
// route's business:
//
//   1. WHICH FILE IS THE CATALOGUE, and what happens when the other one
//      cannot be read. That decision — including the one-shot migration
//      of the deprecated `providers.json` and the fallback to it when
//      the migration fails — is `engine/provider-reads.js`.
//   2. THE GATE. Each of the five endpoints declares the engine
//      capability it needs, and the two write endpoints gate HARD
//      because their whole product is a state the engine reads and
//      webui does not (`engine/provider-writes.js`).
//   3. THE WRITE. One atomic rename of the engine's `config.yaml`,
//      with the ownership rule that keeps an operator's hand-written
//      custom providers alive (`engine/provider-store.js`).
//
// ---------------------------------------------------------------------
// Security contract (unchanged, and pinned by tests)
// ---------------------------------------------------------------------
//   - apiKey is masked in EVERY response path. The public shape is
//     `auth: { type, hasKey, apiKeyMasked, baseURL }`. The route never
//     returns the plaintext key; the masked form is the ONLY shape an
//     apiKey can take on the wire.
//   - The probe handler rejects malformed keys locally — no network
//     call is made when `validateKeyFormat` returns `{ ok: false }`.
//   - Probe requests send the apiKey ONLY to the configured baseURL;
//     a structured error is returned when no baseURL is configured.
//   - `auth.headers` are NOT masked, by decision: they are
//     operator-authored routing configuration, not a credential the
//     server substitutes.
//
// ---------------------------------------------------------------------
// Storage contract (CHANGED by this batch, documented in both docs)
// ---------------------------------------------------------------------
//
//   The catalogue now lives in the engine's `config.yaml`
//   (`custom_provider`), not in `<webuiDataDir>/providers.json`. The
//   deprecated file is read until the store carries its migration
//   marker, and is never written again; a migration that fails leaves
//   it in charge, so the operator keeps the catalogue they had. The
//   response keeps its `sources` and `userPath` fields and their
//   values, because an operator diagnosing a missing provider needs to
//   be told which file the server resolved — that question now has a
//   different answer, and the bilingual docs carry it.
//
// Hot-reload semantics: the store is re-read on every call, so the next
// `GET /api/models` picks a change up immediately, and the
// `providers.updated` SSE broadcast is how the UI learns about it
// without polling.

import { Readable } from "node:stream";

import {
  publicView,
  testProvider as runProbe,
  getUserLevelPath,
  loadUserLevelProviders,
  normaliseConfig,
} from "../lib/providers-config.js";
import {
  PROVIDER_PRESETS,
  publicPresetView,
  presetToMaterialised,
  getPresetById,
} from "../lib/provider-presets.js";
import {
  assertProviderWriteCapability,
  commitProviderCatalogueWrite,
  planProviderCatalogueWrite,
} from "../engine/provider-writes.js";
import {
  checkProviderReadCapability,
  readEngineProviderCatalogue,
} from "../engine/provider-reads.js";
import { getEngineConfigPath, readProviderStore } from "../engine/provider-store.js";
import { pushStateFor, sseByCid } from "../lib/state-bus.js";
import { readJson } from "../lib/read-json.js";
import { shutdownMcodeAcpSingleton } from "../lib/acp-client.js";

/**
 * The active transport. Read through a function so a test can move it
 * between two calls and so the module-scope import cost stays zero —
 * the same rule every other gated route follows.
 *
 * @returns {string}
 */
function activeTransport() {
  return process.env.MCODE_WEBUI_TRANSPORT || "acp";
}

/**
 * Normalise a PUT body into records, or explain why it cannot be.
 * Split out from the handler because the answer decides a 400 and a
 * store write, and a route that inlines both makes the two look like
 * one decision when they are two.
 *
 * @param {object} parsed  The parsed body.
 * @returns {{ok: true, records: object[]}|{ok: false, code: string, error: string}}
 */
export function planCatalogueFromBody(parsed) {
  const norm = normaliseConfig(parsed);
  if (!norm) return { ok: false, code: "BAD_BODY", error: "no providers in body" };
  if (norm.warnings && norm.warnings.length > 0) {
    return { ok: false, code: "BAD_BODY", error: norm.warnings.join("; ") };
  }
  return { ok: true, records: norm.providers };
}

/**
 * Answer a plan failure. Every refusal on the write path is a 400 with
 * the same body, and the one store-level failure that is not the
 * operator's fault is a 500 — the split the pre-B11 handler made, kept
 * exactly so the status a client sees for a bad body does not move.
 *
 * @param {{code: string, error: string}} failure
 * @param {object} res
 * @returns {number} The status written.
 */
function writePlanFailure(failure, res) {
  const status = failure.code === "WRITE_FAILED" ? 500 : 400;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, code: failure.code, error: failure.error }));
  return status;
}

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
 *     userPath: "..."                // the deprecated user-level file
 *   }
 *
 * `sources` is documented (not redacted) — operators need to see which
 * files the server actually resolved.
 *
 * The gate is soft, so it is called for its report and nothing else;
 * the route does not branch on it. That is deliberate: a degraded
 * provider still serves a well-defined catalogue, and hiding the
 * endpoint would remove a working UI over a declaration about who
 * would eventually answer it.
 */
export async function handleGetProviders(_req, res, _ctx) {
  checkProviderReadCapability("GET /api/providers", activeTransport());
  const cfg = await readEngineProviderCatalogue();
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
 * PUT /api/providers — validate and persist the catalogue.
 *
 * Body shape (v2):
 *   { version: 2, providers: [ { id, label, protocol, auth, models, ... } ] }
 *
 * Behaviour, and the one line of it that is new:
 *   - 400 + structured error when any provider fails validation.
 *   - 500 + structured error when the store refuses the write (an
 *     unreadable `config.yaml`, or an I/O failure). The store is
 *     refused rather than overwritten in the first case, so a
 *     syntactically broken engine config does not take the operator's
 *     other engine settings with it.
 *   - 200 + the masked response on success.
 *   - Always broadcasts `providers.updated` after a successful write so
 *     every connected SSE client refreshes its catalogue.
 *
 * The body size is bounded by `lib/read-json.js` (the shared body
 * reader); a too-large payload is answered by the Hono capture with
 * 413 — the same answer every other route returns.
 */
export async function handlePutProviders(req, res, _ctx) {
  const parsed = await readJson(req);
  if (!parsed || typeof parsed !== "object") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: "BAD_BODY", error: "body must be a JSON object" }),
    );
  }
  // HARD gate. The catalogue the operator is about to see is read by
  // the engine, so a provider that cannot manage providers cannot
  // truthfully answer 200 here — see the module header in
  // `engine/provider-writes.js`. Placed AFTER the body check on
  // purpose: a malformed body is the caller's mistake and is a 400
  // whichever engine is registered, and B9 established that ordering
  // for the write family.
  assertProviderWriteCapability("PUT /api/providers", activeTransport());
  // The keep-key convention (ticket 03): an empty or absent
  // `auth.apiKey` means "do not change the existing key", and the
  // previous value is carried over before validation. The lookup is
  // scoped to the STORE's own records — not the merged catalogue — so
  // editing a provider whose key comes from the env or cwd layer does
  // not materialise a deployment secret into the operator's file. The
  // merged view still wins at read time, so nothing changes for the
  // operator.
  // Scoped to the STORE's own records, never the merged catalogue.
  // This is not a stylistic choice: the merged view carries the env and
  // cwd layers, whose keys are deployment-owned, and the convention
  // would then copy one of them into the operator-owned store where
  // the env layer can no longer rotate it. An existing test pinned the
  // pre-B11 scoping and went red the moment this line reached for the
  // merged view.
  const store = readProviderStore();
  const existing = store.ok ? store.records : loadUserLevelProviders();
  const toWrite = Array.isArray(parsed.providers)
    ? { ...parsed, providers: planProviderCatalogueWrite(parsed.providers, existing) }
    : parsed;
  // Validation runs on the CONVENTION-APPLIED body, never on the raw
  // one — the pre-B11 order, and the reason it matters: the
  // convention can only replace an empty or absent key with a stored
  // one, so validating first would reject a body whose key is about to
  // become valid. A `providers` field that is not an array reaches
  // `normaliseConfig` untouched and is refused there, exactly as
  // before.
  const finalPlan = planCatalogueFromBody(toWrite);
  if (!finalPlan.ok) return writePlanFailure(finalPlan, res);
  const result = await commitProviderCatalogueWrite({ records: finalPlan.records });
  if (!result.ok) {
    // 500 with the store's own code. This is the atomicity death line
    // made visible: a refused write means the previous document is
    // still the whole truth, so the client's next GET returns the
    // catalogue it already had, not a mixture.
    return writePlanFailure({ code: "WRITE_FAILED", error: result.error }, res);
  }
  // Tear down the singleton subprocess so the next catalogue operation
  // spawns a fresh one that reads the new config. Brand-new prompt
  // subprocesses spawned by `runMcodeAcp` already pick up the latest
  // config; this is only about the singleton used for session/list,
  // the commands probe and account status. (A no-op under the runtime
  // transport — see KNOWN DEBT 1 in `engine/provider-writes.js`.)
  shutdownMcodeAcpSingleton();
  // Reload + broadcast. The store is re-read on every call (there is no
  // in-process cache), so a follow-up GET already sees the change. The
  // SSE push is the mechanism the UI uses to notice WITHOUT polling.
  await pushProvidersUpdated();
  // The state-bus push keeps the existing snapshot contract intact
  // (the UI's general "refresh from /api/state" hint) — model
  // selectors also re-fetch /api/models because the broadcast carries
  // the masked providers in `event: providers.updated`.
  pushStateFor("__broadcast__");
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      providers: result.records.map(publicView),
      path: getEngineConfigPath(),
      engineSync: { ok: true, written: result.written, keys: result.keys },
    }),
  );
}

/**
 * POST /api/providers/test — per-protocol minimal connectivity probe.
 *
 * Body shape:
 *   { protocol: "openai|anthropic|gemini", auth: { type, apiKey, baseURL } }
 *
 * Order of checks, and both orders are contracts:
 *   1. protocol whitelist (no network for an unknown protocol);
 *   2. local key format (no network for a malformed key);
 *   3. fetch with the configured baseURL (or the protocol default).
 *
 * `baseURL` in the request body is honoured so a UI "test this
 * endpoint" button can exercise a custom URL without going through the
 * persisted config, and `auth.headers` travel WITH the probe, because a
 * probe that omitted them would answer a question about a request the
 * provider will never receive.
 *
 * Unchanged by this batch: the probe does not touch the store, does not
 * need a host, and does not need the gate to be armed — the gate is
 * called for its report, and the endpoint answers either way. KNOWN
 * DEBT 1 in `engine/provider-reads.js` costs the branch that would let
 * the engine answer it instead.
 */
export async function handleTestProvider(req, res, _ctx) {
  const parsed = await readJson(req);
  if (!parsed || typeof parsed !== "object") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: "BAD_BODY", error: "body must be a JSON object" }),
    );
  }
  checkProviderReadCapability("POST /api/providers/test", activeTransport());
  const protocol = typeof parsed.protocol === "string" ? parsed.protocol : "";
  const authRaw = parsed.auth && typeof parsed.auth === "object" ? parsed.auth : {};
  // The request body's `baseURL` (when provided) is the probe target;
  // persisted auth.baseURL is the fallback. Tests pass a fake URL to
  // confirm structured errors without a real network call.
  const auth = {
    type: typeof authRaw.type === "string" ? authRaw.type : "byok",
    apiKey: typeof authRaw.apiKey === "string" ? authRaw.apiKey : "",
    baseURL: typeof authRaw.baseURL === "string" ? authRaw.baseURL : "",
    // Custom headers (webui-parity ticket 85) are forwarded verbatim
    // and re-validated by the prober, because THIS route rebuilds
    // `auth` by hand and never passes through the PUT normaliser.
    headers: authRaw.headers,
  };
  // Optional timeout override (ms) — surfaces from the request body so
  // a UI "quick test" can fire a short probe. Unspecified defaults to
  // the lib's 8s.
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
// The frame carries the masked providers payload; apiKey NEVER appears
// in cleartext (publicView is the only serialiser on this path, by
// design).
// ---------------------------------------------------------------------

async function pushProvidersUpdated() {
  const cfg = await readEngineProviderCatalogue();
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
 * PUT, without writing to any client. Used by tests that want to assert
 * the masked shape directly.
 *
 * @returns {Promise<string>}
 */
export async function _peekProvidersUpdatedFrame() {
  const cfg = await readEngineProviderCatalogue();
  return `event: providers.updated\ndata: ${JSON.stringify({
    version: cfg.version,
    providers: cfg.providers.map(publicView),
  })}\n\n`;
}

/**
 * Test-only helper: returns the raw response stream shape used by the
 * test endpoint when it builds a fake request body.
 *
 * @param {unknown} body
 * @returns {Readable}
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
// The GET response carries each preset's `enabled` flag — true when a
// provider with the same id is already in the configured catalogue, so
// the UI renders "Enabled" / "Enable" without a second round trip.
//
// The POST enable handler:
//   1. resolves the template by id (400 if unknown);
//   2. re-reads the current catalogue;
//   3. if a provider with the same id is already configured, answers
//      200 with the existing record (idempotent — enabling twice is a
//      no-op plus an informational field);
//   4. otherwise prepends the materialised template and commits through
//      the SAME write path as #63, so the persisted store passes the
//      same validation gate and the same atomic rename;
//   5. broadcasts `providers.updated`, so every connected client
//      refreshes its catalogue.
//
// `apiKey` is deliberately left empty on materialisation — the operator
// must supply it after the template is enabled. That record is stored
// with no engine projection (an entry with no key has nothing to call),
// and it comes back on the next read because the store keeps the webui
// record beside the engine fields.
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
export async function handleGetPresets(_req, res, _ctx) {
  checkProviderReadCapability("GET /api/providers/presets", activeTransport());
  const cfg = await readEngineProviderCatalogue();
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
      enabledIds: [...configuredIds].filter((id) => PROVIDER_PRESETS.some((p) => p.id === id)),
    }),
  );
}

/**
 * POST /api/providers/preset/:id/enable — materialise a preset.
 *
 * Behaviour:
 *   - 400 when `id` does not name a known preset.
 *   - 200 (idempotent) when the preset is already configured; the
 *     response carries the existing (masked) provider record so the UI
 *     can re-show it without a second GET.
 *   - 200 when the template was newly enabled; the response carries the
 *     materialised (masked) provider record.
 *
 * Either way a `providers.updated` SSE event is broadcast so every
 * connected client refreshes its catalogue. The commit goes through
 * `commitProviderCatalogueWrite`, the same path as #63, so the store
 * passes the same validation gate and the same atomic rename and the
 * layered resolution applies on the next read.
 */
export async function handleEnablePreset(req, res, _ctx, params = {}) {
  const id =
    (params && typeof params.id === "string" && params.id) || extractIdFromUrl(req.url);
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
  assertProviderWriteCapability("POST /api/providers/preset/:id/enable", activeTransport());
  // Read the current catalogue. The write owns the WHOLE store, so we
  // have to merge with whatever is already there before committing.
  const cfg = await readEngineProviderCatalogue();
  const existing = cfg.providers.find((p) => p.id === tpl.id);
  if (existing) {
    // Idempotent: the preset is already configured. Surface the
    // existing masked record so the caller can re-render it without a
    // second GET.
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

  // New materialisation. Prepend the preset so the UI's "enable" action
  // keeps the preset visible at the top of the provider list; the rest
  // of the catalogue is preserved verbatim.
  const nextRecords = planCatalogueFromBody({
    version: 2,
    providers: [presetToMaterialised(tpl.id), ...cfg.providers],
  });
  if (!nextRecords.ok) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, code: "MATERIALISE_FAILED", error: nextRecords.error }),
    );
  }
  const result = await commitProviderCatalogueWrite({ records: nextRecords.records });
  if (!result.ok) {
    return writePlanFailure({ code: "WRITE_FAILED", error: result.error }, res);
  }
  shutdownMcodeAcpSingleton();
  // Broadcast — the same SSE event #63 uses. The UI's model picker
  // re-fetches /api/models after this, picking up the new
  // template-driven entries.
  await pushProvidersUpdated();
  pushStateFor("__broadcast__");

  const persisted = result.records.find((p) => p.id === tpl.id);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      alreadyEnabled: false,
      provider: publicView(persisted),
      path: getEngineConfigPath(),
      engineSync: { ok: true, written: result.written, keys: result.keys },
    }),
  );
}

/**
 * Pull `:id` out of `req.url` as a fallback when the Hono layer didn't
 * already pass `params`. Kept defensive: the Hono handler always
 * supplies params, but legacy callers / unit tests that synthesise a
 * raw `req` URL may not.
 *
 * @param {string} reqUrl
 * @returns {string}
 */
function extractIdFromUrl(reqUrl) {
  if (typeof reqUrl !== "string") return "";
  const m = reqUrl.match(/\/api\/providers\/preset\/([^/?#]+)\/enable/);
  return m ? decodeURIComponent(m[1]) : "";
}
