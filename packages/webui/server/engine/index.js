// webui/server/engine/index.js
//
// Engine-provider facade — the one place webui code asks "which engine
// surfaces exist?" (engine-abstraction batch B1 / migration step M1).
//
// What ships in THIS batch (and what deliberately does not):
//
//   - Declarations as the first source of truth: each provider module
//     exports a static, reviewed 14-key capability object. This is the
//     design doc §2.3 rule — capabilities are declared, not guessed at
//     runtime.
//   - `GET /api/engine-capabilities` (routes/engine-capabilities.js)
//     exposes the declarations plus the degradation summary, so the
//     frontend can render capability-driven UI without hard-coding
//     provider names.
//   - `assertEngineCapability` + `EngineCapabilityNotSupportedError`
//     (→ HTTP 501) give every future route a one-line gate that can
//     never degrade into a silent empty implementation (#110
//     fake-success discipline).
//
//   - NOT in this batch: runtime probing (design §2.3 step 2 — a
//     read-only probe after catalogue-host ready that could downgrade a
//     declared "full" to "partial" when the environment disagrees, e.g.
//     non-v2 SQLite layouts). Deferred on purpose: no route consumes a
//     probe result yet, and wiring one means touching the catalogue
//     host's lifecycle, which M1 explicitly leaves alone. It lands with
//     the A-batch routes that first need it.
//   - NOT in this batch: transport selection (registry by
//     MCODE_WEBUI_TRANSPORT, acp/exec providers). That is M4; today the
//     only registered host provider is local-runtime-v2, with the
//     TuiRuntimeAdapter surface declared alongside it.
//
// Migration state (design §2.4): M1 done — the host construction moved
// into providers/local-runtime-v2.js and runtime-host.js re-exports it;
// no route's behaviour changed. M3's first batch (B0) done — the
// catalogue host itself is now reached through this facade too
// (engine/host.js), so the plugins and turn-diff routes no longer name
// lib/acp-client.js. M3 batches B1 (#9 #10 #72 #74 #75), B2 (#8 #11),
// B3 (#15 #16 #17 #19) and B4 (#20 #57 #73) done. The rest of M3, then
// M4, will route their consumers through this facade one endpoint
// family at a time.

import { ENGINE_CAPABILITY_KEYS } from "./capabilities.js";
// Declarations only — importing the provider *host-construction* modules
// here would pull the @mavis/* TypeScript tree into every server boot
// (the /api/engine-capabilities route loads this file from app.js).
// Host construction stays behind the lazy boundary runtime-host.js
// always had; nothing on the boot path may import
// providers/local-runtime-v2.js or providers/acp.js-style host modules.
// The same rule applies one level up: engine/host.js reaches
// lib/acp-client.js through a dynamic import, so re-exporting it here
// costs a function, not a module load.
import { LOCAL_RUNTIME_V2_CAPABILITIES } from "./providers/local-runtime-v2.capabilities.js";
import { TUI_RUNTIME_ADAPTER_CAPABILITIES } from "./providers/tui-runtime-adapter.js";

export { ENGINE_CAPABILITY_KEYS };
export { assertEngineCapability, summarizeUnavailableCapabilities, validateEngineCapabilities } from "./capabilities.js";
export {
  EngineCapabilityNotSupportedError,
  engineCapabilityHttpResponse,
  isEngineCapabilityNotSupportedError,
} from "./errors.js";
// The lazy host getter: a function definition, no host, no @mavis/* import.
export { getEngineCatalogueHost } from "./host.js";
// The directory-read family's gated reads (step M3, batch B1). Re-exported
// here so the facade is the one import site for engine reads, but the
// dependency runs the other way too — session-reads.js consults
// getEngineProvider. That cycle is safe for one concrete reason:
// session-reads.js reads NOTHING from this module while it is being
// evaluated. Its own module-scope constant is a literal table, and every
// binding it needs from here (getEngineProvider, DEFAULT_ENGINE_PROVIDER_ID)
// is read inside a function body, so a cold `import("./engine/index.js")`
// can never hit a temporal dead zone. Keep it that way: a new top-level
// `const X = SOMETHING_FROM_INDEX` in session-reads.js breaks the re-export.
// It also stays off the boot path for the reason host.js does —
// lib/acp-client.js and lib/config.js are reached through dynamic import()
// inside the read functions.
export {
  SESSION_READ_ENDPOINTS,
  assertSessionReadCapability,
  readEngineSessionList,
  readEngineSessionListForWorkspace,
  readEngineSessionTitle,
  readEngineVersion,
  resolveSessionReadProvider,
} from "./session-reads.js";
// Step M3, batch B2: the session-tree read (#8) and the export
// enrichment read (#11). Two modules, not one, because their gate
// policies are opposite and a single file would force one of them to
// inherit the other's: #8 is 100% engine data and gates HARD (501 via
// `assertSessionTreeCapability`), while #11's primary source is
// `sessions.json` and gates SOFT (`checkSessionExportCapability`
// reports, never throws) so a provider that cannot serve a transcript
// degrades the enrichment instead of the export. The same TDZ rule as
// B1 applies to both: read nothing from this module at module scope.
export {
  SESSION_TREE_ENDPOINTS,
  assertSessionTreeCapability,
  readEngineSessionTree,
  resolveSessionTreeProvider,
} from "./session-tree-reads.js";
export {
  SESSION_EXPORT_ENDPOINTS,
  checkSessionExportCapability,
  readEngineSessionTranscript,
  resolveSessionExportProvider,
} from "./session-export.js";
// The account read (step M3, batch B4). Same cycle, same rule, same
// reasoning as session-reads.js: account-reads.js reads NOTHING from
// this module at module scope — its `ACCOUNT_READ_ENDPOINTS` table is a
// literal and every binding it needs (`getEngineProvider`,
// `DEFAULT_ENGINE_PROVIDER_ID`) is read inside a function body. A new
// top-level `const X = SOMETHING_FROM_INDEX` in account-reads.js breaks
// the re-export exactly as it would in session-reads.js. It gates HARD
// on `authCredentials.getAccountStatus` — the same pair and the same
// provider method B3's `POST /api/usage` / `POST /api/usage-trigger`
// use, because both read the engine's account projection; the modules
// stay separate because the usage family owns derivations this one
// does not have.
export {
  ACCOUNT_READ_ENDPOINTS,
  assertAccountReadCapability,
  readEngineAccount,
  resolveAccountReadProvider,
} from "./account-reads.js";
// The model-catalogue read (step M3, batch B4) is deliberately NOT
// re-exported here, and that is the one place this file's shape
// disagrees with its siblings. It gates SOFT (the catalogue's primary
// sources are files webui owns, so a provider that declared no model
// surface would not remove the picker — the `session-export.js`
// reasoning, reused rather than re-argued), and its read is
// SYNCHRONOUS, which is what keeps `handleGetModels` synchronous. Both
// properties come from one decision: the three catalogue sources are
// static imports of this module, because `routes/model.js` already
// imported `lib/models.js`, `lib/providers-config.js`,
// `lib/engine-catalogue.js` and `lib/config.js` before M3-B4.
//
// Those four reach `js-yaml` and `@mavis/shared/local-runtime-paths`,
// and `test/lib/engine/host-facade.test.js` is right to refuse that
// under a facade `app.js` loads: it would make `engine/index.js` — the
// one import site the whole server shares, and the one
// `routes/plugins.js` must stay light through — heavier than it has ever
// been, for no saving. So `routes/model.js` imports
// `../engine/model-reads.js` directly, the same shape
// `routes/protocol.js` already uses for `session-reads.js`. The server's
// own boot cost is unchanged: every module involved was already on it
// through the route. When the catalogue read becomes async (M4, with a
// provider-backed source), the module can move back behind
// `await import()` and be re-exported here with the rest.
// The capability-declaration read (step M3, batch B4). Declares NO
// capability for #73 — it IS the declaration endpoint, and gating the
// gate would let a `none` hide the declaration that says so. It is the
// one endpoint in the migration whose response body gains a key
// (`engine`, the engine-capabilities view); see the module header for
// why that is additive rather than a replacement.
export {
  CAPABILITY_READ_ENDPOINTS,
  checkCapabilityReadCapability,
  readEngineCapabilityView,
  resolveCapabilityReadProvider,
} from "./capability-reads.js";
// The usage family's gated reads (step M3, batch B3). Same cycle, same
// rule, same reasoning as session-reads.js above: usage-reads.js reads
// NOTHING from this module at module scope — its `USAGE_READ_ENDPOINTS`
// table is a literal and every binding it needs (`getEngineProvider`,
// `DEFAULT_ENGINE_PROVIDER_ID`) is read inside a function body. A new
// top-level `const X = SOMETHING_FROM_INDEX` in usage-reads.js breaks the
// re-export exactly as it would in session-reads.js.
export {
  USAGE_READ_ENDPOINTS,
  assertUsageReadCapability,
  contextUsedTokens,
  readEngineAccountQuota,
  readEngineQuotaForecast,
  readEngineSessionUsage,
  resolveUsageReadProvider,
} from "./usage-reads.js";
export { LOCAL_RUNTIME_V2_CAPABILITIES } from "./providers/local-runtime-v2.capabilities.js";
export { TUI_RUNTIME_ADAPTER_CAPABILITIES } from "./providers/tui-runtime-adapter.js";

/**
 * Registered providers. `transport` records which wire form the provider
 * speaks — both current entries are the in-process runtime ("runtime");
 * M4 adds "acp" and "exec" entries when those become providers.
 */
const PROVIDERS = Object.freeze({
  "local-runtime-v2": {
    id: "local-runtime-v2",
    transport: "runtime",
    capabilities: LOCAL_RUNTIME_V2_CAPABILITIES,
  },
  "tui-runtime-adapter": {
    id: "tui-runtime-adapter",
    transport: "runtime",
    capabilities: TUI_RUNTIME_ADAPTER_CAPABILITIES,
  },
});

/** The provider new engine work should target first (the v2 host). */
export const DEFAULT_ENGINE_PROVIDER_ID = "local-runtime-v2";

/**
 * Read a provider's capability declaration.
 *
 * @param {string} [providerId] Provider id; defaults to
 *        DEFAULT_ENGINE_PROVIDER_ID. Unknown ids throw a plain Error
 *        (caller confusion, not an engine limitation — the HTTP layer
 *        maps that case to 404, never to 501).
 * @returns {{id: string, transport: string, capabilities: object}}
 */
export function getEngineProvider(providerId = DEFAULT_ENGINE_PROVIDER_ID) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    // `code` lets the HTTP layer distinguish caller confusion (404)
    // from engine limitations (501) without string matching. Everything
    // else thrown across this seam must propagate unchanged.
    const err = new Error(
      `getEngineProvider: unknown provider "${providerId}" (known: ${Object.keys(PROVIDERS).join(", ")})`,
    );
    err.code = "unknown_engine_provider";
    throw err;
  }
  return provider;
}

/** All registered provider ids (for the endpoint's consumer listing). */
export function listEngineProviderIds() {
  return Object.keys(PROVIDERS);
}
