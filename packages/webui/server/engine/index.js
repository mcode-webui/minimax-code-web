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
//   - M4-1 (done): the `acp` TRANSPORT is now a registered provider
//     with a declared 14-key surface, so the transport webui has always
//     defaulted to finally has an auditable answer. It is registered
//     and nothing more: no `providerByTransport()` table lists it yet,
//     so no consumer resolves to it and no gate's verdict changed —
//     see the PROVIDERS block below and the acp declaration's header.
//     M4-2 (the `exec` provider) and M4-3 (chat.js transport selection
//     reading the registry) remain.
//
// Migration state (design §2.4): M1 done — the host construction moved
// into providers/local-runtime-v2.js and runtime-host.js re-exports it;
// no route's behaviour changed. M3's first batch (B0) done — the
// catalogue host itself is now reached through this facade too
// (engine/host.js), so the plugins and turn-diff routes no longer name
// lib/acp-client.js. M3 batches B1 (#9 #10 #72 #74 #75), B2 (#8 #11),
// B3 (#15 #16 #17 #19), B4 (#20 #57 #73), B5 (#7 #4 #6), B6 (#3),
// B7 (#13 #69 #70 #71), B8a (#12's pure layer + gate), B8b (#12's
// runner + route branch) and B9 (#67 #68 — the first family whose gate
// changes what a client sees, gated HARD on purpose; see the
// mode-writes.js block below) done. The rest of M3, then M4, will route
// their consumers through this facade one endpoint family at a time.
// M4-1 done — the acp transport is registered with its own declaration
// and the plan's reverse exception (turnDiff/plugins are `none` on the
// protocol yet served by the in-process v2 host) is recorded per key
// via `servedBy`, validated at import and readable through
// `resolveCapabilityHostProvider`. No `providerByTransport()` table
// names it yet; that is M4-3.

import { ENGINE_CAPABILITY_KEYS, summarizeCapabilityHosting } from "./capabilities.js";
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
import { ACP_CAPABILITIES } from "./providers/acp.capabilities.js";

export { ENGINE_CAPABILITY_KEYS };
export {
  assertEngineCapability,
  summarizeCapabilityHosting,
  summarizeUnavailableCapabilities,
  validateEngineCapabilities,
} from "./capabilities.js";
export {
  EngineCapabilityNotSupportedError,
  engineCapabilityHttpResponse,
  isEngineCapabilityNotSupportedError,
} from "./errors.js";
// The lazy host getter: a function definition, no host, no @mavis/* import.
export { getEngineCatalogueHost } from "./host.js";
// The host-services window (placeholder batch PB-8): the read side of the
// V2 owner graph, for the capability families the product facades do not
// carry — PB-7 (agents, `services.agent`), PB-3 (worktrees,
// `services.managedWorktrees`) and anything else that finds no use case on
// `host.application` / `host.applications`. It is a window and nothing
// more: no route consumes it yet, and each consumer batch owns its own
// capability gate. Its only static import is `engine/host.js`, so the
// boot-path rule the header above states holds here unchanged —
// re-exporting it costs a function, not a module load.
export { getHostServices } from "./host-services.js";
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
// one endpoint in the migration whose response CONTRACT changed:
// `capabilities` used to carry `MCODE_ACP_CAPABILITIES`, the flat ACP
// wire table, and now carries the provider's DECLARED 14-key object — a
// user-authorised replacement, not an addition. The `engine` key an
// earlier shape of this batch shipped was removed rather than kept,
// because with the declaration already under `capabilities` it would
// have carried the same 14 keys a second time in one response; what
// survives is the provenance (`capabilitiesProvider` /
// `capabilitiesProviderFor`) and the derived `capabilitiesUnavailable`.
// See the module header for the full statement and the debt note on the
// now-unconsumed constant.
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
// The session WRITE family (step M3, batch B5): #7 delete, #4 rename,
// #6 cleanup-orphans. Same cycle, same TDZ rule, same reasoning as
// session-reads.js above: session-writes.js reads NOTHING from this
// module at module scope — its `SESSION_WRITE_ENDPOINTS` table is a
// literal and every binding it needs (`getEngineProvider`,
// `DEFAULT_ENGINE_PROVIDER_ID`) is read inside a function body. A new
// top-level `const X = SOMETHING_FROM_INDEX` in session-writes.js breaks
// the re-export exactly as it would in session-reads.js. Its static
// imports are `engine/capabilities.js`, `engine/index.js` and `node:fs`
// (a builtin); all six of its storage dependencies are reached through
// `await import()` inside the functions, so the boot-path rule the other
// families follow holds here too.
//
// Two of its three endpoints gate HARD on `sessionCrud` · `deleteSession`
// — #7 and #6, both because they destroy rows in the engine's own
// `local_runtime_*` tables — and the third, #4, declares NO capability
// because a rename writes webui's own session store and touches no engine
// surface at all. The policy is decided by who owns the rows the write
// destroys, which is a different question from the read families' and
// does not have the same answer twice in a row here. See the module
// header for the full argument and for the known debt this batch records
// rather than settles.
export {
  ORPHAN_STALE_MS,
  SESSION_WRITE_ENDPOINTS,
  applyDeletedSessionToClientState,
  applyEngineSessionRename,
  applyRenamedSessionToClientState,
  assertSessionWriteCapability,
  clientMatchesDeletedSession,
  clientMatchesRenamedSession,
  commitEngineOrphanSessionDelete,
  commitEngineSessionDelete,
  isMcodeSessionId,
  isOrphanSessionRecord,
  planEngineSessionDelete,
  previewEngineSessionDelete,
  readOrphanSessionWriteIds,
  resolveSessionTarget,
  resolveSessionWriteProvider,
  selectOrphanSessionIds,
} from "./session-writes.js";
// The session SWITCH family (step M3, batch B6): #3
// POST /api/sessions/switch. Same cycle, same TDZ rule, same reasoning as
// session-writes.js above: session-switch.js reads NOTHING from this module
// at module scope — its `SESSION_SWITCH_ENDPOINTS` table is a literal and
// every binding it needs (`getEngineProvider`, `DEFAULT_ENGINE_PROVIDER_ID`)
// is read inside a function body. A new top-level `const X =
// SOMETHING_FROM_INDEX` in session-switch.js breaks the re-export exactly as
// it would in session-writes.js. Its ONLY static import beyond this module
// is `engine/capabilities.js`; the session store, the ACP client, the
// transcript reader, the usage tables, the workspace gate, the state bus
// and the config are all reached through `await import()` inside the
// data-plane function.
//
// It gates SOFT (`checkSessionSwitchCapability` reports, never throws) for
// the reason `session-export.js` does: the switch's primary data is webui's
// own session record, and both of its engine touches (the title and the
// transcript) have a defined degradation. Gating hard would remove a
// working endpoint in response to a declaration about an enrichment it can
// live without — and would do it on the default `acp` transport first,
// where the enrichment is the only part in question. The 501 machinery
// stays unused by this family, and the suite pins that.
export {
  SESSION_SWITCH_ENDPOINTS,
  applyEngineSessionSwitch,
  applySwitchedSessionToClientState,
  chatLooksCumulative,
  checkSessionSwitchCapability,
  isSwitchableMcodeSessionId,
  lookupCachedMcodeTitle,
  readEngineSwitchTranscript,
  resolveSessionSwitchProvider,
  resolveSwitchTarget,
  resolveSwitchWorkspace,
  selectTranscriptBackfill,
} from "./session-switch.js";
// The STREAMING SEND family (step M3, batches B8a and B8b): #12
// POST /api/send. Same cycle, same TDZ rule, same reasoning:
// streaming-send.js's `STREAMING_SEND_ENDPOINTS` table is a literal and
// every binding it needs (`getEngineProvider`,
// `DEFAULT_ENGINE_PROVIDER_ID`) is read inside a function body, so a
// cold `import("./engine/index.js")` can never hit a temporal dead
// zone. Its static imports are `engine/capabilities.js`,
// `engine/index.js` and the node builtins; the host getter, the
// per-turn host wrapper and the attachments helper are reached through
// `await import()` inside the data plane, which is what keeps an
// acp-only server off the runtime graph.
//
// It gates HARD, the first M3 family to do so, and the reason is
// structural rather than a policy preference: #12's response is
// `{ok:true}` written BEFORE the engine is called, so a provider with
// no send surface could only be answered with an ack for a turn that
// never runs. See that module's header for the full argument, for the
// two of the three red lines it owns, and for the eight recorded
// debts.
export {
  SEND_EVENT_KINDS,
  STREAMING_SEND_ENDPOINTS,
  assertStreamingSendCapability,
  checkStreamingSendCapability,
  classifySendEvent,
  openEngineSendStream,
  projectSendAttachments,
  resolveStreamingSendProvider,
  rewriteDrainedAnswerLine,
  sendSegmentAdvance,
  sendStillViewing,
  sendTerminalOutcome,
  sendToolHeaderLine,
  sendToolUpdate,
  sendUsageTotals,
} from "./streaming-send.js";
export { LOCAL_RUNTIME_V2_CAPABILITIES } from "./providers/local-runtime-v2.capabilities.js";
export { TUI_RUNTIME_ADAPTER_CAPABILITIES } from "./providers/tui-runtime-adapter.js";
export { ACP_CAPABILITIES } from "./providers/acp.capabilities.js";
// The INTERRUPT family (step M3, batch B7): #13 POST /api/stop, #69
// POST /api/protocol/cancel. Same cycle, same TDZ rule, same reasoning
// as session-reads.js above: interrupt.js reads NOTHING from this module
// at module scope — its `INTERRUPT_ENDPOINTS` table is a literal and
// every binding it needs (`getEngineProvider`,
// `DEFAULT_ENGINE_PROVIDER_ID`) is read inside a function body. A new
// top-level `const X = SOMETHING_FROM_INDEX` in interrupt.js breaks the
// re-export exactly as it would in session-reads.js. Its ONLY static
// imports are `engine/index.js` and the node builtins; the state bus,
// the RPC wrapper and the config are reached through `await import()`
// inside the data-plane functions, which is what keeps the escalation
// timer and the kill cascade off the boot path.
//
// It gates SOFT for both endpoints, and the reason is endpoint-specific
// rather than family-wide: #13's escalation is webui's own
// child-process management and its zombie-claim reset is the user's
// only escape hatch from a stuck run, so hard-gating it would delete a
// working endpoint over a doubt about its GENTLE half; #69 already has
// a truthful "I could not deliver it" shape as its documented contract.
// The 501 machinery stays unused by this family, and the suite pins that.
export {
  INTERRUPT_ENDPOINTS,
  STOP_FORCE_KILL_MS,
  applyEngineStop,
  checkInterruptCapability,
  resolveInterruptProvider,
  sendEngineSessionCancel,
  stopLeftStaleClaim,
} from "./interrupt.js";
// The LOAD / ACTIVATE family (step M3, batch B7): #70
// POST /api/protocol/load-session, #71
// POST /api/protocol/activate-session. Same cycle, same TDZ rule, same
// reasoning: session-load.js's `SESSION_LOAD_ENDPOINTS` table is a
// literal and every binding it needs is read inside a function body; a
// new top-level `const X = SOMETHING_FROM_INDEX` there breaks this
// re-export exactly as it would anywhere else. Its only static imports
// are `engine/capabilities.js` and `engine/index.js`.
//
// This is the one M3 family that carries BOTH gate forms, and the split
// is a decision rather than an inconsistency: #70 gates HARD on
// `sessionCrud` · `loadSession`, because a "success" that skipped the
// engine would write a sidebar entry for a session the engine never
// loaded — the fake success the gate exists to prevent — while #71 gates
// SOFT, because hard-gating it would be silently answering the
// activate-semantic-collapse question the plan leaves open (semantic
// collapse vs 501). Both branches are costed in that module's KNOWN
// DEBT 1. Two functions, one family, one store, one route module:
// splitting it would duplicate the transport table, the resolver and
// the status mappers to preserve a distinction one `enforcement` field
// wide.
export {
  SESSION_LOAD_ENDPOINTS,
  activateEngineSession,
  activateFailureStatus,
  assertSessionLoadCapability,
  checkSessionActivateCapability,
  loadEngineSession,
  loadFailureStatus,
  loadFailureWireCode,
  resolveSessionLoadProvider,
} from "./session-load.js";
// The SESSION MODE WRITE family (step M3, batch B9): #67 set-mode, #68
// set-config-option. Same cycle, same TDZ rule, same reasoning:
// mode-writes.js's `MODE_WRITE_ENDPOINTS` and
// `MODE_WRITE_BRIDGED_CONFIG_IDS` are both literals and every binding it
// needs is read inside a function body; a new top-level `const X =
// SOMETHING_FROM_INDEX` there breaks this re-export exactly as it would
// anywhere else. Its only static imports are `engine/capabilities.js`
// and `engine/index.js`; the RPC wrapper and the config are reached
// through `await import()` inside the data-plane functions.
//
// Both endpoints gate HARD, and this is the one M3 family where the hard
// gate is the batch's REASON rather than a consequence of having no
// fallback: it is the first family that deliberately changes what a
// client sees, and the entire change is "a provider that declares the
// capability absent answers the gate's 501 instead of having the write
// forwarded". `MODE_WRITE_BRIDGED_CONFIG_IDS` is the other half of
// that sentence — the two config ids webui's own controls depend on
// (`model`, `permissionMode`) are exempt from the generic-write
// refusal, and the frontend reads the same two names to decide which
// controls to hide.
export {
  MODE_WRITE_BRIDGED_CONFIG_IDS,
  MODE_WRITE_ENDPOINTS,
  assertModeWriteCapability,
  resolveModeWriteProvider,
  resolveModeWriteSubItem,
  setConfigOptionFailureStatus,
  setEngineSessionConfigOption,
  setEngineSessionMode,
  setModeFailureStatus,
} from "./mode-writes.js";

/**
 * Registered providers. `transport` records which wire form the provider
 * speaks. M4-1 adds the first non-runtime entry: `acp`, the protocol
 * webui has ALWAYS defaulted to (`MCODE_WEBUI_TRANSPORT` resolves to
 * "acp"), which until now had no declaration anywhere and therefore no
 * auditable answer to "what can this transport do".
 *
 * Registering it changes NO routing. Every consumer resolves a provider
 * through its own transport→provider table (`providerByTransport()` in
 * each of the M3 families), and none of those tables lists `acp` — a
 * table entry naming the transport is M4-3's change, and until it
 * happens `resolve*Provider("acp")` returns `null` and every gate
 * no-ops exactly as it did before this entry existed. That gap is the
 * reason the declaration is safe to land first, and
 * test/lib/engine/capabilities.test.js pins it from both sides: this
 * entry exists, and no consumer reaches it yet.
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
  acp: {
    id: "acp",
    transport: "acp",
    capabilities: ACP_CAPABILITIES,
  },
});

// A `servedBy` naming a provider that is not registered is a
// DECLARATION bug, not a caller mistake: it would leave a hosted
// capability with no host, and the first sign of it would be a 501
// from a route nobody gated. `validateEngineCapabilities` can check the
// field's shape but not whether the id exists — this module is the
// only place that knows the registry, and checking here means the
// server refuses to boot rather than answering a question with a lie.
// (Same discipline as the per-provider self-check each declaration
// module runs on itself.)
for (const provider of Object.values(PROVIDERS)) {
  for (const { key, servedBy } of summarizeCapabilityHosting(provider.capabilities)) {
    if (!PROVIDERS[servedBy]) {
      throw new Error(
        `${provider.id}.${key} is declared servedBy "${servedBy}", which is not a registered engine provider ` +
          `(known: ${Object.keys(PROVIDERS).join(", ")})`,
      );
    }
  }
}

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

/**
 * Which provider's host actually answers `capability` for `providerId`,
 * or `null` when this provider serves it itself.
 *
 * This is the query M4-3's transport-aware gates need and the one that
 * keeps the M3 plan's reverse exception from becoming a regression. The
 * acp provider declares `turnDiff` and `plugins` `none` and names
 * `local-runtime-v2` as the host that serves them, so a gate that asks
 * "can this transport answer a turn-diff request?" must consult this
 * rather than the level alone — the two `/api/turn-diff` and ten
 * `/api/plugins` endpoints have worked on the acp transport since
 * before M3, and answering 501 for them would be a regression dressed
 * up as an honest declaration.
 *
 * Returns a provider ID, not a provider object, so a caller cannot
 * reach through it to a host it did not gate on. `null` covers both
 * "this provider serves it itself" and "this key is not declared
 * hosted" — the two are the same answer to the question asked here.
 *
 * @param {string} providerId
 * @param {string} capability  One of ENGINE_CAPABILITY_KEYS.
 * @returns {string|null}
 */
export function resolveCapabilityHostProvider(providerId, capability) {
  const provider = getEngineProvider(providerId);
  const entry = provider.capabilities[capability];
  if (!entry || entry.level !== "none") return null;
  const servedBy = entry.servedBy;
  return typeof servedBy === "string" && PROVIDERS[servedBy] ? servedBy : null;
}
