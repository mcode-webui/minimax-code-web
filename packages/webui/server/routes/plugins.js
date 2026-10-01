// webui/server/routes/plugins.js
// The plugins management surface (ticket 60 phase 1, slice A).
//
//   GET  /api/plugins/installed        installed plugins, official + local merged
//   GET  /api/plugins/marketplace      marketplace page for one explicit source
//   GET  /api/plugins/enabled          the enabled subset of the current snapshot
//   POST /api/plugins/refresh          reconcile official + local state
//   POST /api/plugins/enable           enable one plugin by name
//   POST /api/plugins/disable          disable one plugin by name
//   POST /api/plugins/install          install one plugin by name
//   POST /api/plugins/uninstall        uninstall one plugin by name
//   POST /api/plugins/import/preview   preview a GitHub plugin package
//   POST /api/plugins/import           import a GitHub plugin package
//
// Zero new backend. Every endpoint is a thin projection over a method that
// `PluginDesktopFacade` (local-runtime-v2) already implements; this file owns
// input validation, the wire shape and the failure mapping, nothing else.
// The logic for reconciliation, persistence and the official/local branch
// stays in the runtime.
//
// Data source: the catalogue host's `cliService`, reached through the
// engine facade's `getEngineCatalogueHost()` (server/engine/host.js), which
// forwards to the `getCatalogueHost()` singleton in `lib/acp-client.js`.
// The host is booted unconditionally on first call, on purpose:
//
//   - `MCODE_WEBUI_TRANSPORT` defaults to `acp`, and `transportWantsCatalogue()`
//     only gates *session-list* traffic. ACP has no plugin method at all, so
//     gating plugins on the transport would leave the panel dead in the
//     default mode — the getter is called directly instead.
//   - Never build a second host. Two CliService instances over one dataDir is
//     both wasteful and a split brain against the plugin-state tables.
//
// Gates are not re-implemented here: `createHonoApp`'s middleware runs the
// shared chain (`lib/gates.js`) for every owned route, so a read-only server
// answers the five POSTs with 403 and that is correct, not a bug.
//
// Wire contract:
//   success            200 { ok: true, ...data }
//   request validation 400 { ok: false, code: "invalidBody", error }
//   runtime failure    200 { ok: false, error, code }   — HTTP 200 by design:
//                      the failure is a data-plane answer the client branches
//                      on by `code`, not a transport fault. Facade validation
//                      codes are the one exception: they mean the *request* was
//                      wrong, so they answer 400 with the code preserved.
//
// `source` on the wire is the runtime enum (1 = official, 2 = local). Every
// plugin element that carries it also carries a `sourceKind` string
// ("official" | "local") so the webapp never has to import the protocol
// package to tell the two apart (`@mavis/webui` does not depend on it).

import { getEngineCatalogueHost } from "../engine/index.js";
import { readJson } from "../lib/read-json.js";

/** Page size when the caller sends no `limit`; matches the facade default. */
const DEFAULT_LIMIT = 50;
/** Hard ceiling, also the facade's `MAX_LIMIT`. */
const MAX_LIMIT = 200;

/**
 * Facade codes that mean "the request was malformed", not "the runtime
 * failed". They answer 400 with the code intact so the client can react
 * (a cursor from a previous keyword is the common one:
 * `PLUGIN_CURSOR_INVALID`).
 */
const VALIDATION_CODES = new Set([
  "INVALID_PLUGIN_SOURCE",
  "PLUGIN_LIMIT_INVALID",
  "PLUGIN_CURSOR_INVALID",
]);

const SOURCE_OFFICIAL = 1;
const SOURCE_LOCAL = 2;
const SOURCE_KIND = { 1: "official", 2: "local" };

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** The default data source: the catalogue host singleton's bare cliService. */
async function defaultGetCliService() {
  const host = await getEngineCatalogueHost();
  return host ? host.cliService : null;
}

function codeOf(error, fallback) {
  if (error && typeof error.code === "string" && error.code) return error.code;
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function messageOf(error) {
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return String(error);
}

function respondRuntimeError(res, error) {
  const code = codeOf(error, "PLUGIN_RUNTIME_ERROR");
  // A facade validation code is a 400: the client sent something the runtime
  // refuses to interpret, and answering 200 would invite it to retry forever.
  const status = VALIDATION_CODES.has(code) ? 400 : 200;
  json(res, status, { ok: false, error: messageOf(error), code });
}

function badBody(res, error) {
  json(res, 400, { ok: false, error, code: "invalidBody" });
}

function notAvailable(res) {
  json(res, 200, {
    ok: false,
    error: "runtime unavailable",
    code: "RUNTIME_UNAVAILABLE",
  });
}

/**
 * Resolve the cliService, run `fn` with it, and answer whichever of the three
 * outcomes happened. Every endpoint goes through here, so the failure shape is
 * defined in exactly one place.
 */
async function withCliService(res, deps, fn) {
  const getCliService = (deps && deps.getCliService) || defaultGetCliService;
  let cliService;
  try {
    cliService = await getCliService();
  } catch (error) {
    respondRuntimeError(res, error);
    return;
  }
  if (!cliService) {
    notAvailable(res);
    return;
  }
  try {
    json(res, 200, await fn(cliService));
  } catch (error) {
    respondRuntimeError(res, error);
  }
}

// ---------------------------------------------------------------------------
// Query / body parsing
// ---------------------------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A positive integer query parameter. `undefined` means absent, and is
 * *dropped* from the request rather than sent as `null` — the facade's
 * `pageLimit` treats only `undefined` as "use the default" and rejects
 * anything non-integer, so a forwarded `null` would turn every parameterless
 * request into `PLUGIN_LIMIT_INVALID`. A present-but-unusable value is a 400
 * here rather than a round trip.
 */
function readLimitParam(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: `limit must be a positive integer (got ${JSON.stringify(raw)})` };
  }
  const value = Number.parseInt(raw, 10);
  if (value <= 0) {
    return { ok: false, error: `limit must be a positive integer (got ${JSON.stringify(raw)})` };
  }
  return { ok: true, value: Math.min(value, MAX_LIMIT) };
}

function readOptionalIntParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (!/^-?\d+$/.test(raw.trim())) {
    return { ok: false, error: `${name} must be an integer (got ${JSON.stringify(raw)})` };
  }
  return { ok: true, value: Number.parseInt(raw, 10) };
}

function readOptionalStringParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  return { ok: true, value: raw };
}

/** `source` for the mutation endpoints: optional, but 1 or 2 when present. */
function readOptionalSource(body) {
  if (!("source" in body) || body.source === undefined || body.source === null) {
    return { ok: true, value: undefined };
  }
  if (body.source !== SOURCE_OFFICIAL && body.source !== SOURCE_LOCAL) {
    return { ok: false, error: `source must be 1 (official) or 2 (local)` };
  }
  return { ok: true, value: body.source };
}

/**
 * `source` for the marketplace endpoint is mandatory, and the reason is a
 * runtime trap rather than API taste: the facade's `readSource` maps
 * `undefined` to OFFICIAL, so a request that omits `source` would silently
 * dial the cloud registry, whose base URL is a `.invalid` placeholder that
 * does not resolve in the local edition — the panel would hang on a request
 * that can never succeed. Requiring the parameter makes the local tab
 * (`?source=2`) the only way to get local data, and makes the official tab an
 * explicit, consciously unreachable request.
 */
function readRequiredSource(url) {
  const raw = url.searchParams.get("source");
  if (raw === null || raw === "") {
    return { ok: false, error: "source is required and must be 1 (official) or 2 (local)" };
  }
  if (raw !== String(SOURCE_OFFICIAL) && raw !== String(SOURCE_LOCAL)) {
    return { ok: false, error: `source must be 1 (official) or 2 (local) (got ${JSON.stringify(raw)})` };
  }
  return { ok: true, value: Number.parseInt(raw, 10) };
}

/** Attach the protocol-free `sourceKind` string to one plugin element. */
function withSourceKind(plugin, sourceKind) {
  if (!plugin || typeof plugin !== "object") return plugin;
  const kind = sourceKind || SOURCE_KIND[plugin.source] || "unknown";
  return { ...plugin, sourceKind: kind };
}

function projectPlugins(plugins, sourceKind) {
  if (!Array.isArray(plugins)) return [];
  return plugins.map((plugin) => withSourceKind(plugin, sourceKind));
}

/** Drop `undefined` so the JSON body carries only the fields the facade set. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// #1  GET /api/plugins/installed — plugins.list.installed
// ---------------------------------------------------------------------------

export async function handlePluginsInstalled(req, res, _ctx, deps = {}) {
  const url = new URL(req.url, "http://localhost");
  const limit = readLimitParam(url);
  if (!limit.ok) return badBody(res, limit.error);
  const keyword = readOptionalStringParam(url, "keyword");
  if (!keyword.ok) return badBody(res, keyword.error);
  const cursor = readOptionalStringParam(url, "cursor");
  if (!cursor.ok) return badBody(res, cursor.error);

  const request = compact({
    keyword: keyword.value,
    limit: limit.value,
    cursor: cursor.value,
  });

  return withCliService(res, deps, async (cliService) => {
    const result = await cliService.listInstalledPlugins(request);
    return {
      ok: true,
      plugins: projectPlugins(result && result.plugins),
      hasMore: Boolean(result && result.hasMore),
      nextCursor: result ? result.nextCursor : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// #2  GET /api/plugins/marketplace — plugins.list.marketplace
// ---------------------------------------------------------------------------

export async function handlePluginsMarketplace(req, res, _ctx, deps = {}) {
  const url = new URL(req.url, "http://localhost");
  const source = readRequiredSource(url);
  if (!source.ok) return badBody(res, source.error);
  const limit = readLimitParam(url);
  if (!limit.ok) return badBody(res, limit.error);
  const skillLimit = readOptionalIntParam(url, "skillLimit");
  if (!skillLimit.ok) return badBody(res, skillLimit.error);
  const category = readOptionalIntParam(url, "category");
  if (!category.ok) return badBody(res, category.error);
  const keyword = readOptionalStringParam(url, "keyword");
  if (!keyword.ok) return badBody(res, keyword.error);
  const cursor = readOptionalStringParam(url, "cursor");
  if (!cursor.ok) return badBody(res, cursor.error);
  const skillCursor = readOptionalStringParam(url, "skillCursor");
  if (!skillCursor.ok) return badBody(res, skillCursor.error);

  const request = compact({
    source: source.value,
    keyword: keyword.value,
    limit: limit.value,
    cursor: cursor.value,
    category: category.value,
    skillLimit: skillLimit.value,
    skillCursor: skillCursor.value,
  });

  return withCliService(res, deps, async (cliService) => {
    const result = await cliService.listMarketplacePlugins(request);
    // A marketplace summary carries no per-element `source` (the page *is*
    // one source), so the kind is stamped from the requested source.
    const kind = SOURCE_KIND[source.value];
    return compact({
      ok: true,
      source: source.value,
      sourceKind: kind,
      plugins: projectPlugins(result && result.plugins, kind),
      hasMore: Boolean(result && result.hasMore),
      nextCursor: result ? result.nextCursor : undefined,
      pluginTotal: result ? result.pluginTotal : undefined,
      marketplaceSkills: result ? result.marketplaceSkills : undefined,
      skillHasMore: result ? result.skillHasMore : undefined,
      skillNextCursor: result ? result.skillNextCursor : undefined,
      cursorResetRequired: result ? result.cursorResetRequired : undefined,
    });
  });
}

// ---------------------------------------------------------------------------
// #3  GET /api/plugins/enabled — plugins.list.enabled
// ---------------------------------------------------------------------------

export async function handlePluginsEnabled(_req, res, _ctx, deps = {}) {
  return withCliService(res, deps, async (cliService) => {
    const result = await cliService.listEnabledPlugins({});
    return {
      ok: true,
      plugins: Array.isArray(result && result.plugins) ? result.plugins : [],
    };
  });
}

// ---------------------------------------------------------------------------
// #4  POST /api/plugins/refresh — plugins.refresh.all
// ---------------------------------------------------------------------------

export async function handlePluginsRefresh(req, res, _ctx, deps = {}) {
  // Drained rather than skipped: an unread body would desync a keep-alive
  // socket, and the shared reader is also where the 1 MiB cap lives.
  await readJson(req);
  return withCliService(res, deps, async (cliService) => {
    await cliService.refreshPlugins();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// #5-#8  mutations by name — plugins.{enable,disable,install,uninstall}.by_name
// ---------------------------------------------------------------------------

async function handleMutateByName(res, deps, method, req) {
  const body = await readJson(req);
  if (!isNonEmptyString(body.pluginName)) {
    return badBody(res, "pluginName must be a non-empty string");
  }
  const source = readOptionalSource(body);
  if (!source.ok) return badBody(res, source.error);

  const request = compact({ pluginName: body.pluginName.trim(), source: source.value });
  return withCliService(res, deps, async (cliService) => {
    const result = await cliService[method](request);
    return compact({
      ok: true,
      source: result ? result.source : undefined,
      sourceKind: result ? SOURCE_KIND[result.source] : undefined,
      installExists: Boolean(result && result.installExists),
      enabled: Boolean(result && result.enabled),
    });
  });
}

export async function handlePluginsEnable(req, res, _ctx, deps = {}) {
  return handleMutateByName(res, deps, "enablePlugin", req);
}

export async function handlePluginsDisable(req, res, _ctx, deps = {}) {
  return handleMutateByName(res, deps, "disablePlugin", req);
}

export async function handlePluginsInstall(req, res, _ctx, deps = {}) {
  return handleMutateByName(res, deps, "installPlugin", req);
}

export async function handlePluginsUninstall(req, res, _ctx, deps = {}) {
  return handleMutateByName(res, deps, "uninstallPlugin", req);
}

// ---------------------------------------------------------------------------
// #9  POST /api/plugins/import/preview — plugins.import.preview_url
// ---------------------------------------------------------------------------

export async function handlePluginsImportPreview(req, res, _ctx, deps = {}) {
  const body = await readJson(req);
  if (!isNonEmptyString(body.url)) {
    return badBody(res, "url must be a non-empty string");
  }
  const url = body.url.trim();
  return withCliService(res, deps, async (cliService) => {
    // No AbortSignal: the Hono capture handler has no per-request abort to
    // bridge. The facade treats an absent signal as "never cancelled".
    const result = await cliService.previewGithubPlugin({ url });
    return {
      ok: true,
      source: result.source,
      plugin: result.plugin,
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [],
      packageSizeBytes: result.packageSizeBytes,
      canImport: Boolean(result.canImport),
    };
  });
}

// ---------------------------------------------------------------------------
// #10  POST /api/plugins/import — plugins.import.from_url
// ---------------------------------------------------------------------------

export async function handlePluginsImport(req, res, _ctx, deps = {}) {
  const body = await readJson(req);
  const source = body.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return badBody(res, "source must be an object");
  }
  if (!isNonEmptyString(source.repositoryUrl) || !isNonEmptyString(source.commitSha)) {
    return badBody(res, "source.repositoryUrl and source.commitSha must be non-empty strings");
  }
  if (source.subPath !== undefined && typeof source.subPath !== "string") {
    return badBody(res, "source.subPath must be a string when present");
  }

  const githubSource = compact({
    repositoryUrl: source.repositoryUrl.trim(),
    commitSha: source.commitSha.trim(),
    subPath: typeof source.subPath === "string" ? source.subPath : undefined,
  });

  return withCliService(res, deps, async (cliService) => {
    const result = await cliService.importGithubPlugin({ source: githubSource });
    return { ok: true, plugin: result.plugin };
  });
}
