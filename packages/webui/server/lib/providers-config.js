// webui/server/lib/providers-config.js
// Provider configuration v2 schema, layered resolution, masking helpers,
// and per-protocol minimal connectivity probes.
//
// Schema (v2, backward-compatible with v1):
//
//   {
//     "version": 2,
//     "providers": [
//       {
//         "id":     "openai_compat",
//         "label":  "OpenAI Compat",
//         "preset": "openai",            // optional
//         "enabled": true,                // default true
//         "protocol": "openai"|"anthropic"|"gemini",
//         "auth": {
//           "type":    "byok"|"coding-plan",
//           "apiKey":  "sk-...",
//           "baseURL": "https://...",     // optional (provider's own; default per protocol)
//           "headers": { "X-Tenant": "acme" }  // optional; extra outbound headers, see below
//         },
//         "models": [
//           {
//             "id":            "gpt-4o-mini",
//             "label":         "GPT-4o mini",
//             "contextLimit":  128000,
//             "thinkingLevels":["low","medium","high"],
//             "modalities":    ["text","image"]
//           }
//         ]
//       }
//     ]
//   }
//
// v1 (and the prior single-file shape) keeps working:
//   { "providers": [{ "id", "label", "models": [{ id, label, contextLimit }] }] }
//
// Layered resolution (highest priority wins on per-field basis):
//   1. `MCODE_WEBUI_MODELS_CONFIG` env (pointing at a JSON file) — env layer
//   2. cwd `models.json`                                              — cwd layer
//   3. user-level `~/.mcode-webui/providers.json`                     — user layer
//
// Same-id provider deep-merge: lower layer fills in fields the higher
// one leaves undefined; scalars (label / protocol / enabled) overwrite.
// Models inside a provider are deduped by `id` with the higher layer
// winning — a key set by the env layer overrides one set by cwd (and
// env > cwd > user-level).
//
// Security:
//   - `apiKey` is masked in every public response (maskKey()).
//   - `auth.headers` is NOT masked and IS echoed back verbatim: these
//     are routing/tenant configuration the operator typed, not a
//     credential the server substituted. A provider that needs a
//     secret per-request belongs behind the apiKey field, which is
//     masked. The trade is stated in docs/webui.md and its zh-CN twin.
//   - Header names and values are validated against a strict grammar
//     (`normalizeCustomHeaders`) before anything persists or reaches
//     the outbound request path, so a stored config cannot inject
//     extra header lines into an upstream request.
//   - Connectivity probes only fire AFTER a local format check passes.
//   - When `apiKey` is absent, probe runs with no credential header and
//     receives the same structured error shape.
//
// The caching shape is deliberately tiny: the user-level file is the
// only layer with mutable state (the env / cwd layers are re-read on
// every call so a deployment can roll a config without a server
// restart). The user-level file is read on every load too, but
// repeated reads of the same path on the same tick are coalesced by
// the routes themselves (handleGetProviders / handleGetModels).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// =====================================================================
// Constants
// =====================================================================

/** Schema version emitted by `loadProvidersConfig()`. */
export const SCHEMA_VERSION = 2;

/** Allowed protocols. Anything else is rejected on PUT (validation). */
export const ALLOWED_PROTOCOLS = new Set(["openai", "anthropic", "gemini"]);
/** Allowed auth types. */
export const ALLOWED_AUTH_TYPES = new Set(["byok", "coding-plan"]);

// ---------------------------------------------------------------------
// Custom headers
// ---------------------------------------------------------------------
/** Ceilings for `auth.headers`. A provider is a user-typed record on
 *  the operator's own machine, not an untrusted network input, so these
 *  are abuse guards (a pasted 10k-header blob) rather than a security
 *  boundary. They are deliberately generous: real gateways need a
 *  handful of headers, not dozens. */
export const MAX_CUSTOM_HEADERS = 20;
export const MAX_HEADER_NAME_LEN = 128;
export const MAX_HEADER_VALUE_LEN = 4096;

/**
 * HTTP field-name grammar (RFC 9110 §5.6.2 token), reduced to the
 * characters that can actually break a request line or a header block.
 *
 * WHY THIS IS A HARD FILTER AND NOT A SANITISE: these values are
 * concatenated into outbound request headers by the runtime
 * (`local-runtime-v2` merges `options.headers` into the upstream
 * request). A name or value carrying CR, LF, or NUL would let a
 * stored config inject additional header lines — or a whole second
 * request — into that upstream call. Rejecting the whole record is
 * the only response that cannot be misread: silently stripping the
 * character would leave the operator believing a header is in effect
 * when the upstream never saw it intact.
 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * Normalise one provider's custom-header map.
 *
 * Returns `{ ok: true, headers }` with a plain string→string object
 * (a fresh object, never a caller-held reference), or `{ ok: false,
 * error }` on the first offending entry. An absent / empty / non-object
 * input normalises to `{}` — the common case, and the reason this does
 * not need an `absent` sentinel the way the apiKey keep-convention
 * does.
 *
 * Duplicate names cannot occur: a JS object literal already collapsed
 * them at parse time, and a JSON body with duplicate keys keeps the
 * last one. The surviving value is the one that is validated, so the
 * stored map and the request that leaves the process agree.
 */
export function normalizeCustomHeaders(raw) {
  if (raw === undefined || raw === null) return { ok: true, headers: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "auth.headers must be an object" };
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return {
      ok: false,
      error: `auth.headers has ${entries.length} entries, limit is ${MAX_CUSTOM_HEADERS}`,
    };
  }
  const headers = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME_RE.test(name) || name.length > MAX_HEADER_NAME_LEN) {
      return { ok: false, error: `auth.headers: invalid header name '${name}'` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `auth.headers: '${name}' must be a string` };
    }
    if (value.length > MAX_HEADER_VALUE_LEN) {
      return {
        ok: false,
        error: `auth.headers: '${name}' exceeds ${MAX_HEADER_VALUE_LEN} characters`,
      };
    }
    // Control characters are legal in a header VALUE (obs-fold aside,
    // which no modern client sends) except for the ones that end the
    // line. Tab is explicitly allowed by the grammar.
    if (/[\r\n\0]/.test(value)) {
      return { ok: false, error: `auth.headers: '${name}' contains a line break or NUL` };
    }
    headers[name] = value;
  }
  return { ok: true, headers };
}


/** Persistent user-level file path. Lazy: respects MCODE_WEBUI_DATA_DIR. */
export function getUserLevelPath() {
  const base =
    process.env.MCODE_WEBUI_DATA_DIR || join(homedir(), ".mcode-webui");
  return join(base, "providers.json");
}

/**
 * Cwd-layer path: the env override wins when set; otherwise `<cwd>/models.json`.
 * Same precedence as the v1 `readModelsConfig` in routes/model.js.
 */
export function getCwdLayerPath() {
  return process.env.MCODE_WEBUI_MODELS_CONFIG || join(process.cwd(), "models.json");
}

// =====================================================================
// File I/O
// =====================================================================

/** Best-effort JSON parse: returns `null` on missing file / parse error. */
function safeReadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// =====================================================================
// Validation / normalisation
// =====================================================================


function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function bool(v, fallback = false) {
  return typeof v === "boolean" ? v : fallback;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Local-only key format probe — no network. Returns `{ ok: true }` when
 * the key looks usable, otherwise `{ ok: false, reason }`. Used by the
 * `/api/providers/test` handler to reject obviously malformed keys
 * before the network call.
 *
 * Rules are deliberately loose: each protocol has its own shape; we
 * accept any non-empty string for "coding-plan" (auth may be opaque),
 * and require non-empty trimmed length ≥ 8 for `byok` (the OpenAI /
 * Anthropic / Gemini public keys are all ≥ 32 chars, but a project
 * proxy may use a shorter token; the upper bound is `len ≤ 4096` to
 * keep absurd inputs from reaching the network).
 */
export function validateKeyFormat(auth) {
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "auth is missing" };
  }
  const type = auth.type;
  if (type !== "byok" && type !== "coding-plan") {
    return { ok: false, reason: "auth.type must be byok or coding-plan" };
  }
  if (type === "coding-plan") {
    // coding-plan auth can be opaque (the provider may not even
    // expose an apiKey); we only require *some* credential or baseURL
    // so a probe has a target. baseURL alone is enough.
    if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) {
      if (auth.apiKey.length > 4096) {
        return { ok: false, reason: "auth.apiKey is too long (> 4096 chars)" };
      }
    }
    return { ok: true };
  }
  // byok: an apiKey is required
  const key = typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
  if (!key) return { ok: false, reason: "auth.apiKey is required for byok" };
  if (key.length < 8) return { ok: false, reason: "auth.apiKey is too short (< 8 chars)" };
  if (key.length > 4096) return { ok: false, reason: "auth.apiKey is too long (> 4096 chars)" };
  return { ok: true };
}

/**
 * Validate one provider record. Returns `{ ok: true, value }` with a
 * normalised copy, or `{ ok: false, error }` on the first bad field.
 * Pure (no IO) so the parser can run on every call without writing
 * back to disk.
 */
export function normaliseProvider(p) {
  if (!p || typeof p !== "object") {
    return { ok: false, error: "provider is not an object" };
  }
  const id = str(p.id).trim();
  if (!id) return { ok: false, error: "provider.id is required" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-]*$/.test(id)) {
    return {
      ok: false,
      error: `provider.id '${id}' must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/`,
    };
  }
  const protocol = str(p.protocol).trim() || "openai"; // v1 records omitted protocol — default to openai (most permissive)
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      error: `provider '${id}': protocol must be one of ${[...ALLOWED_PROTOCOLS].join(", ")}`,
    };
  }
  const authRaw = p.auth && typeof p.auth === "object" ? p.auth : {};
  // v1 records omitted the `auth` object entirely — default to
  // byok so legacy configs still load. Operators who care about
  // auth fidelity can PUT a v2 body afterwards.
  const authType = str(authRaw.type).trim() || "byok";
  if (!ALLOWED_AUTH_TYPES.has(authType)) {
    return {
      ok: false,
      error: `provider '${id}': auth.type must be byok or coding-plan`,
    };
  }
  const auth = {
    type: authType,
    apiKey: typeof authRaw.apiKey === "string" ? authRaw.apiKey : "",
    baseURL: typeof authRaw.baseURL === "string" ? authRaw.baseURL : "",
  };
  // Custom headers are OPTIONAL and additive: a config written before
  // this field existed normalises to `{}` and a PUT that omits them
  // keeps `{}` — the same as a provider that never had any. There is
  // no keep-sentinel, because unlike the apiKey there is no secret to
  // mask on the way out: the operator typed these values and reads
  // them back verbatim.
  const hdr = normalizeCustomHeaders(authRaw.headers);
  if (!hdr.ok) {
    return { ok: false, error: `provider '${id}': ${hdr.error}` };
  }
  auth.headers = hdr.headers;
  if (auth.apiKey) {
    const fmt = validateKeyFormat(auth);
    if (!fmt.ok) return { ok: false, error: `provider '${id}': ${fmt.reason}` };
  }
  const modelsRaw = arr(p.models);
  const seenModel = new Set();
  const models = [];
  for (const m of modelsRaw) {
    if (!m || typeof m !== "object") continue;
    const mid = str(m.id).trim();
    if (!mid) continue;
    if (seenModel.has(mid)) continue; // dedupe inside one provider
    seenModel.add(mid);
    const model = {
      id: mid,
      label: str(m.label).trim() || mid,
      contextLimit: num(m.contextLimit),
      thinkingLevels: arr(m.thinkingLevels)
        .filter((x) => typeof x === "string" && x.length > 0),
      modalities: arr(m.modalities)
        .filter((x) => typeof x === "string" && x.length > 0),
    };
    // Drop null/undefined fields so the on-disk shape stays minimal
    if (model.contextLimit === null) delete model.contextLimit;
    if (model.thinkingLevels.length === 0) delete model.thinkingLevels;
    if (model.modalities.length === 0) delete model.modalities;
    models.push(model);
  }
  return {
    ok: true,
    value: {
      id,
      label: str(p.label).trim() || id,
      preset: typeof p.preset === "string" ? p.preset : undefined,
      enabled: bool(p.enabled, true),
      protocol,
      auth,
      models,
    },
  };
}

/**
 * Normalise the whole top-level object. Accepts both v1 and v2 shapes:
 *   v1: { providers: [{ id, label, models: [...] }] }
 *   v2: { version: 2, providers: [...] }
 * v1 records are upgraded in place — protocol/auth default to safe
 * placeholders so v1 entries still load (no test rejects them), but
 * a GET response that carries a v1 record shows it as `protocol: "openai"`
 * with `enabled: true` (the most permissive default). Operators who
 * care about protocol fidelity should put their config through the
 * PUT handler, which only accepts v2.
 */
export function normaliseConfig(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const providersRaw = arr(parsed.providers);
  if (providersRaw.length === 0 && !parsed.providers) return null;
  const seenProvider = new Set();
  const providers = [];
  const errors = [];
  for (const p of providersRaw) {
    const r = normaliseProvider(p);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    if (seenProvider.has(r.value.id)) {
      errors.push(`duplicate provider id '${r.value.id}'`);
      continue;
    }
    seenProvider.add(r.value.id);
    providers.push(r.value);
  }
  return {
    version: SCHEMA_VERSION,
    providers,
    ...(errors.length > 0 ? { warnings: errors } : {}),
  };
}

// =====================================================================
// Layered resolution + deep merge
// =====================================================================

/**
 * Read one layer. Returns `null` when the layer file is missing or
 * malformed. The cwd/env layer can be v1; the user-level layer is v2
 * (the PUT handler enforces v2 there).
 */
function readLayer(path) {
  const parsed = safeReadJson(path);
  if (!parsed) return null;
  // v1 (or a non-versioned body) is accepted too — normaliseConfig
  // handles both.
  return normaliseConfig(parsed);
}

/**
 * Deep merge two provider arrays, higher layer wins:
 *   - Higher-layer provider with the same `id` overrides the lower one
 *     wholesale. (Per-field merge would let env silently "patch" a
 *     baseURL into a user-level provider — surprising, and the ticket
 *     explicitly asks for "higher layer wins" on per-provider level.)
 *   - Models inside a provider: dedupe by id, higher-layer model
 *     wins.
 *   - If only one layer defines the provider, it passes through.
 *
 * Layer precedence is the same as `loadProvidersConfig()`: env > cwd > user.
 */
export function mergeProviderLists(layers) {
  // layers: [ [envLayer], [cwdLayer], [userLayer] ] (each is array|null)
  const byId = new Map();
  // Lower layers first (so a higher layer's `set` wins). Iterate in
  // DECLARED order: first item is lowest priority, last is highest.
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!Array.isArray(layer)) continue;
    for (const p of layer) {
      if (!p || !p.id) continue;
      const existing = byId.get(p.id);
      if (!existing) {
        byId.set(p.id, cloneProvider(p));
        continue;
      }
      // Higher layer overrides scalars wholesale; models merge by id.
      const merged = mergeProvider(existing, p);
      byId.set(p.id, merged);
    }
  }
  return [...byId.values()];
}

function cloneProvider(p) {
  return {
    ...p,
    auth: { ...p.auth },
    models: p.models.map((m) => ({ ...m })),
  };
}

function mergeProvider(lower, higher) {
  // Scalars / protocol / auth come from the higher layer verbatim.
  // Models are union-by-id with the higher-layer model winning on collision.
  const modelById = new Map();
  for (const m of lower.models || []) modelById.set(m.id, m);
  for (const m of higher.models || []) modelById.set(m.id, m);
  return {
    id: higher.id,
    label: higher.label,
    preset: higher.preset ?? lower.preset,
    enabled: typeof higher.enabled === "boolean" ? higher.enabled : lower.enabled,
    protocol: higher.protocol,
    auth: {
      type: higher.auth.type,
      apiKey: higher.auth.apiKey || lower.auth.apiKey || "",
      baseURL: higher.auth.baseURL || lower.auth.baseURL || "",
    },
    models: [...modelById.values()],
  };
}

/**
 * Resolve the merged providers config from all three layers.
 * - env layer  : `MCODE_WEBUI_MODELS_CONFIG` (or cwd/models.json fallback)
 * - cwd layer  : `<cwd>/models.json` (only when env override is unset)
 * - user layer : `~/.mcode-webui/providers.json` (or env override of data dir)
 *
 * The cwd layer is intentionally skipped when `MCODE_WEBUI_MODELS_CONFIG`
 * is set (env layer "is" the cwd path; two layers pointing at the same
 * file would double-count).
 *
 * `opts.userLayer` (batch B11) REPLACES the user layer with an
 * already-resolved provider list, which is how the engine's provider
 * store takes over as the authority while the env and cwd layers keep
 * their existing precedence, their existing per-call re-read, and their
 * existing "deployment-owned, never written" property. The default —
 * no `opts` — is the deprecated user file, so this module stays
 * usable (and testable) on its own.
 *
 * @param {{userLayer?: object[]}} [opts]
 * @returns {{version: number, providers: object[], sources: object}}
 */
export function loadProvidersConfig(opts = {}) {
  const envPath = process.env.MCODE_WEBUI_MODELS_CONFIG;
  const cwdPath = envPath ? null : join(process.cwd(), "models.json");
  const userPath = getUserLevelPath();

  const envLayer = envPath ? readLayer(envPath) : null;
  const cwdLayer = cwdPath ? readLayer(cwdPath) : null;
  const userLayer = Array.isArray(opts.userLayer)
    ? { providers: opts.userLayer }
    : existsSync(userPath)
      ? readLayer(userPath)
      : null;

  const layers = [userLayer, cwdLayer, envLayer]; // lowest -> highest priority
  const sources = {
    env: envPath || null,
    cwd: cwdPath,
    user: userPath,
  };
  // env + cwd + user reading errors silently become null layers; the
  // layered merge still works (missing layers are skipped).
  const providers = mergeProviderLists([
    userLayer?.providers,
    cwdLayer?.providers,
    envLayer?.providers,
  ]);
  return {
    version: SCHEMA_VERSION,
    providers,
    sources,
  };
}

// =====================================================================
// Masking
// =====================================================================

/**
 * Mask an apiKey for display / API response. The plaintext NEVER
 * leaves the server in any response path — `maskKey` is the only
 * shape an apiKey can take in a response body, and the route handlers
 * call it before any object is serialised.
 *
 * Rules:
 *   - falsy / non-string  → "" (caller decides whether to include the field at all)
 *   - length < 8          → "***" (the whole key is shorter than the
 *                           visible "first 4 + last 4" framing)
 *   - length ≤ 12         → first 2 + "***" + last 2 (e.g. "ab***yz")
 *   - length > 12         → first 4 + "***" + last 4
 *
 * These lengths are picked so a 32-char Anthropic / OpenAI / Gemini
 * key is shown as "sk-aa…bb" — readable, but no substring beyond the
 * boundary can be used as a credential.
 */
export function maskKey(apiKey) {
  if (typeof apiKey !== "string") return "";
  const k = apiKey.trim();
  if (!k) return "";
  if (k.length < 8) return "***";
  if (k.length <= 12) return `${k.slice(0, 2)}***${k.slice(-2)}`;
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

/**
 * Public-safe view of one provider: apiKey replaced by masked string,
 * baseURL kept (operators need to see what endpoint they configured),
 * everything else verbatim. Use this for every API response that
 * carries a provider — there is NO other serialisation path, by
 * design.
 */
export function publicView(provider) {
  return {
    id: provider.id,
    label: provider.label,
    preset: provider.preset,
    enabled: provider.enabled !== false,
    protocol: provider.protocol,
    auth: {
      type: provider.auth.type,
      hasKey: !!(provider.auth.apiKey && provider.auth.apiKey.length > 0),
      apiKeyMasked: maskKey(provider.auth.apiKey),
      baseURL: provider.auth.baseURL || "",
      // Custom headers are NOT masked. They are operator-authored
      // routing/auth-adjacent configuration (a tenant id, a gateway
      // routing key) that the operator typed and must be able to read
      // back to edit it — masking them would make the field a
      // write-only trap, the exact failure the apiKey placeholder
      // convention avoids by masking only the SECRET. An operator
      // who treats a header value as a secret has no way to express
      // that here; that trade is stated in both docs.
      headers: { ...(provider.auth.headers ?? {}) },
    },
    models: provider.models.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.contextLimit ? { contextLimit: m.contextLimit } : {}),
      ...(m.thinkingLevels && m.thinkingLevels.length > 0
        ? { thinkingLevels: [...m.thinkingLevels] }
        : {}),
      ...(m.modalities && m.modalities.length > 0
        ? { modalities: [...m.modalities] }
        : {}),
    })),
  };
}

// =====================================================================
// Connectivity probes (per protocol)
// =====================================================================

/** Default base URLs when a provider leaves baseURL empty. */
const DEFAULT_BASE_URL = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/**
 * Run one probe and resolve to `{ ok, latencyMs, detail }`. The
 * detail shape carries the response status and a short, human-readable
 * message — no response body (the upstream error message could leak
 * the credential in a misconfigured proxy). Caller decides what to
 * surface.
 *
 * Timeout: 8s. Long enough for cold starts, short enough to keep the
 * UI responsive.
 */
async function probe({ protocol, auth, baseURLOverride, timeoutMs = 8000 }) {
  const baseURL =
    (typeof baseURLOverride === "string" && baseURLOverride) ||
    DEFAULT_BASE_URL[protocol] ||
    "";
  if (!baseURL) {
    return { ok: false, latencyMs: 0, error: "no base URL configured" };
  }
  // Custom headers travel WITH the probe. A probe that omitted them
  // would answer a question the operator never asked: against a
  // gateway that requires `X-Tenant`, the bare probe fails while the
  // real request would have succeeded — or worse, succeeds while the
  // real request would have been rejected for a missing header.
  // The probe must exercise the request that will actually be sent.
  //
  // Re-validated here because `/api/providers/test` takes its `auth`
  // straight from the request body without going through the PUT
  // normaliser. The filter is the same one the config path uses, so
  // a value that could not be stored also cannot be probed with.
  const hdr = normalizeCustomHeaders(auth?.headers);
  const customHeaders = hdr.ok ? hdr.headers : {};
  const started = Date.now();
  let ctrl;
  try {
    ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const result = await runProtocolProbe({
      protocol,
      baseURL,
      auth: { ...auth, headers: customHeaders },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ...result, latencyMs: Date.now() - started };
  } catch (e) {
    const message =
      e && e.name === "AbortError" ? "timeout" : e && e.message ? e.message : String(e);
    return { ok: false, latencyMs: Date.now() - started, error: message };
  } finally {
    if (ctrl) try { ctrl.abort(); } catch {}
  }
}

async function runProtocolProbe({ protocol, baseURL, auth, signal }) {
  // Operator headers are spread FIRST in every branch, so the
  // protocol's own required headers below overwrite them. A probe is
  // "can I reach this provider", not a configurable HTTP client: an
  // operator who mistypes `Content-Type` in the header field should
  // get a probe that still means something. The production path (the
  // runtime's own header merge) is NOT restricted this way — this
  // asymmetry is deliberate and is what the granularity note in both
  // docs refers to.
  const custom = auth?.headers ?? {};
  if (protocol === "openai") {
    // `GET {baseURL}/v1/models` with `Authorization: Bearer <key>` (when present)
    const headers = { ...custom, Accept: "application/json" };
    if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
    const res = await fetch(`${trimSlash(baseURL)}/v1/models`, { method: "GET", headers, signal });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    return { ok: false, error: `HTTP ${res.status}` };
  }
  if (protocol === "anthropic") {
    // `POST {baseURL}/v1/messages` with `x-api-key` header (when present)
    //   body: { model:"claude-3-5-sonnet-20241022", max_tokens:1, messages:[...] }
    // `claude-3-5-sonnet-20241022` is the smallest stable probe model — it
    // costs nothing to query for a 1-token response and avoids the
    // `model not found` failure mode that earlier versions of the
    // probe had when a custom baseURL did not accept `claude-3-haiku`.
    const headers = {
      ...custom,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
    };
    if (auth.apiKey) headers["x-api-key"] = auth.apiKey;
    const body = JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    const res = await fetch(`${trimSlash(baseURL)}/v1/messages`, {
      method: "POST",
      headers,
      body,
      signal,
    });
    // Anthropic returns 200 even on max_tokens=0 when the request is
    // accepted. 400 is the typical failure when the key is wrong.
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    return { ok: false, error: `HTTP ${res.status}` };
  }
  if (protocol === "gemini") {
    // `GET {baseURL}/v1beta/models?key=<key>` (key is in the URL, not a
    // header — that's the Gemini spec). Custom headers still apply.
    const url = new URL(`${trimSlash(baseURL)}/v1beta/models`);
    if (auth.apiKey) url.searchParams.set("key", auth.apiKey);
    const res = await fetch(url.toString(), {
      method: "GET",
      ...(Object.keys(custom).length > 0 ? { headers: { ...custom } } : {}),
      signal,
    });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return { ok: false, error: `unsupported protocol '${protocol}'` };
}

function trimSlash(s) {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Top-level entry: validate the request locally, then run the probe.
 * Returns a structured error when validation fails — no network call
 * is made in that branch. Tests pin this contract.
 *
 * `timeoutMs` defaults to 8000ms; tests pass a shorter value so
 * the no-network-for-malformed-input contract doesn't slow the
 * suite (the coding-plan + unreachable-baseURL branch is otherwise
 * a real fetch that times out).
 */
export async function testProvider({ protocol, auth, timeoutMs }) {
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      code: "BAD_PROTOCOL",
      error: `protocol must be one of ${[...ALLOWED_PROTOCOLS].join(", ")}`,
    };
  }
  const fmt = validateKeyFormat(auth || {});
  if (!fmt.ok) {
    return { ok: false, code: "INVALID_KEY", error: fmt.reason };
  }
  // `auth.baseURL` is the probe target (the route's documented
  // contract: "the request body's baseURL is honoured so a UI 'test
  // this endpoint' button can exercise a custom URL"); the protocol
  // default is the fallback ONLY when it is empty. Passing it as
  // `baseURLOverride` fixes a gap where the body's baseURL was read
  // and validated but then dropped, sending every probe to the
  // protocol default instead — a custom-endpoint dialog button
  // probed the wrong target (ticket 56, found live: a local mock
  // endpoint answered while the probe timed out against the
  // default's unreachable host).
  const r = await probe({
    protocol,
    auth,
    baseURLOverride: auth && typeof auth.baseURL === "string" ? auth.baseURL : "",
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (r.ok) return { ok: true, latencyMs: r.latencyMs, detail: r.detail };
  return {
    ok: false,
    code: "PROBE_FAILED",
    error: r.error,
    latencyMs: r.latencyMs,
  };
}

// =====================================================================
// Persistence — MOVED (batch B11)
// =====================================================================
//
// `writeProvidersConfig` and its `atomicWriteJson` helper used to live
// here. They are gone with the dual-source arrangement they served:
// `providers.json` is no longer written by anything, and the store that
// replaced it is written by `engine/provider-store.js` with a different
// shape (YAML, mode 0600, one rename), a different ownership rule
// (foreign engine entries survive) and a different failure surface (an
// unreadable engine config is refused rather than overwritten).
//
// What this module still owns, and why it is the right owner: the
// SCHEMA. Normalisation, validation, masking, the layered resolution
// and the connectivity probe are all still about what a provider
// record MEANS, and a write target that changed does not change any of
// them. `loadProvidersConfig({userLayer})` is the seam the new store
// reads through.

/**
 * Used by tests / routes that want to assert "plaintext key was never
 * written to disk". Returns the raw `apiKey` from the parsed body —
 * never expose this through an API response. Internal test helper.
 */
export function _extractPlaintextKey(provider) {
  return provider && provider.auth && typeof provider.auth.apiKey === "string"
    ? provider.auth.apiKey
    : "";
}

// =====================================================================
// Keep-existing-key convention (ticket 03 cross-branch API note)
// =====================================================================
//
// Background: GET /api/providers returns `apiKeyMasked` (e.g. "sk-aa***bb")
// rather than the plaintext, so a UI that PUTs back what it has on screen
// would send the masked value as the new apiKey — the plaintext would be
// lost on every edit. There is no "unchanged" semantics in the v2 PUT
// contract (ticket 01 deliberately kept the body a full replacement so
// the validation/normalisation path is simple), so the management UI
// ships a convention on top:
//
//   * incoming `auth.apiKey` is the empty string OR is absent
//     (`undefined`) — both are interpreted as "do not change the
//     existing key for this provider id". The handler copies the
//     existing key onto the incoming record before
//     validation/normalisation. Treating the absent-field case the
//     same as empty is intentional: the v2 normaliser coerces a
//     missing `auth.apiKey` to `""` anyway, and silently writing
//     `""` to disk would wipe a credential the operator never
//     intended to change (the field's HTML placeholder carries the
//     masked value, not the controlled value, so a UI that drops the
//     field is the normal "no change" gesture).
//
//   * anything non-empty — including the masked placeholder — is
//     treated as the new value. The UI must therefore blank the field
//     when the user does not want to overwrite it (the editor renders
//     the masked placeholder as the input's placeholder, not its
//     value).
//
//   * DELIBERATE KEY CLEARING IS NOT POSSIBLE. There is no wire shape
//     that results in a stored key becoming empty once one has been
//     written. Operators who need to rotate a credential PUT a new
//     value; the convention preserves the previous key only when the
//     incoming record signals "no change". The documentation
//     (`webapp/lib/i18n.ts` "API key" placeholder) carries the same
//     caveat in user-visible form.
//
// Layer scope: the convention reads `loadUserLevelProviders()`
// (user-level file only — NOT the merged result), so the env / cwd
// layers' secrets are never materialised into the user-level file
// when an operator edits an env-defined provider. The merged view
// still wins for the engine — `loadProvidersConfig()` keeps the env
// priority — so the operator's edit does not "pin" an env secret to
// disk by accident.
//
// Cross-branch API note: the convention lives on this branch
// (ticket 03) because ticket 01's PUT contract was already merged
// without it. The convention is opt-in — a UI that always sends the
// plaintext only sees normal replacement behaviour. The PUT handler
// is the only place this helper runs, so the rest of the validation
// surface is unchanged.

/**
 * Read JUST the user-level providers file, without the env/cwd merge.
 *
 * Used by `applyKeepKeyConvention` so the convention's "previous key"
 * lookup is scoped to the layer the operator owns — the env/cwd
 * layers are deployment-managed, and silently copying one of THEIR
 * keys into the user-level file would materialise a deployment
 * secret onto operator-managed disk (where the convention can no
 * longer rotate it). Returns `[]` when the file is missing or
 * malformed, matching the `loadProvidersConfig()` contract.
 */
export function loadUserLevelProviders() {
  const userPath = getUserLevelPath();
  const parsed = safeReadJson(userPath);
  if (!parsed) return [];
  const norm = normaliseConfig(parsed);
  return norm && Array.isArray(norm.providers) ? norm.providers : [];
}

/**
 * Apply the keep-existing-key convention.
 *
 * For every incoming provider whose `auth.apiKey` is empty OR absent
 * (the sentinel):
 *   - if a same-id provider exists in `existing` with a non-empty
 *     `auth.apiKey`, copy it onto the incoming record;
 *   - if no such existing provider exists (the incoming record is
 *     brand new), the empty stays empty and the normal validation
 *     flow rejects it for `byok` (which is the right behaviour: a
 *     new byok provider with no key cannot pass a test probe).
 *
 * The function is pure (no IO). Returns a NEW array — `incoming` is
 * not mutated, so the original body still exists for error reporting
 * if the caller wants to surface it.
 */
export function applyKeepKeyConvention(existing, incoming) {
  const existingById = new Map();
  for (const p of existing || []) {
    if (p && p.id) existingById.set(p.id, p);
  }
  return (incoming || []).map((p) => {
    if (!p || typeof p !== "object") return p;
    const auth = p.auth && typeof p.auth === "object" ? p.auth : {};
    // The sentinel: empty string (explicit "I typed nothing") OR
    // absent (the field was never sent). Both mean "do not change
    // the existing key". A non-string apiKey (number, boolean) is
    // left untouched — those are upstream mistakes that the normaliser
    // will surface as a type mismatch on its own.
    const apiKeyIsSentinel =
      typeof auth.apiKey === "undefined" || auth.apiKey === "";
    if (!apiKeyIsSentinel) return p;
    const previous = existingById.get(p.id);
    const previousKey =
      previous && previous.auth && typeof previous.auth.apiKey === "string"
        ? previous.auth.apiKey
        : "";
    return {
      ...p,
      auth: { ...auth, apiKey: previousKey },
    };
  });
}