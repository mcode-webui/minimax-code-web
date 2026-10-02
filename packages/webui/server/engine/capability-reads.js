// webui/server/engine/capability-reads.js
//
// Migration step M3, batch B4: the capability-declaration read
// (能力声明读) —
//
//   #73  GET /api/protocol/capabilities — "what can this engine do?"
//
// What this file is for, and why it is the odd one out in this batch.
// #73 is the endpoint the FRONTEND uses to decide which controls to
// enable, and until M3-B4 it answered from two places webui maintains
// by hand:
//
//   - `MCODE_ACP_CAPABILITIES`, a flat `{method: boolean}` table in
//     `lib/mcode-rpc.js` describing the ACP JSON-RPC surface; and
//   - `getMcodeServerInfo()`, the ACP `initialize` mirror, for the
//     engine's name / title / version.
//
// Neither is the engine's DECLARED capability surface. That surface
// already exists — it is the 14-key per-provider declaration in
// `engine/capabilities.js` and the registry in `engine/index.js`, and
// `GET /api/engine-capabilities` already serves it. So webui was
// carrying two parallel answers to "what can the engine do", able to
// disagree, with no test able to notice. After M3-B4 #73 carries the
// engine-capabilities VIEW alongside the ACP wire table: the route no
// longer reaches into `lib/mcode-rpc.js` and `lib/acp-client.js` on
// its own, and the two answers sit in one response where a consumer
// (or a reviewer) can see both and their disagreement.
//
// The wire table is KEPT, not replaced. `capabilities` still answers
// "which ACP method does the frontend's control map onto", which is
// not what the 14 matrix keys answer ("does the engine have this
// capability at all"). Dropping it would break `docs/API.md`'s
// documented response and every consumer that reads
// `capabilities.set_mode`; the engine view is ADDITIVE. That is the
// one place in this batch where the response body gains a key, and it
// is a deliberate, reviewed decision rather than a refactor side
// effect — the existing keys keep their exact values.
//
// Why this endpoint declares NO capability. It is the declaration
// endpoint: gating the gate is circular, and a `none` anywhere in the
// declaration must not be able to hide the declaration that says so.
// The value is `null` for the same reason B1's `/api/health` and B3's
// `/api/usage/forecast` are, and the gate REPORTS the no-op rather
// than passing silently. `checkCapabilityReadCapability` is exported so
// the symmetry with the other families is visible and testable, and so
// a future batch that adds a REAL capability-gated sibling has a
// predicate to build on.
//
// What this file deliberately does NOT do:
//
//   - It does not probe. Runtime probing (design §2.3 step 2) is
//     deliberately absent for every family in this migration; this
//     endpoint is declaration-backed, and a probe result that silently
//     overrode the declaration would make the frontend's rendering
//     depend on timing.
//   - It does not construct a host.
//   - It does not convert the engine's `"unknown"` version into an
//     error. `/api/health` (#75) already answers that same figure with
//     the same fallback through `session-reads.js#readEngineVersion`,
//     and two endpoints asking the same protocol question with the same
//     answer is correct; two endpoints answering it DIFFERENTLY is
//     not, which is why both read `getMcodeServerInfo()` and both keep
//     the literal `"unknown"` fallback.
//
// Boot-path weight. `app.js` imports `routes/protocol.js`, the route
// imports this file, so this file is on the boot path. It statically
// imports nothing heavier than `capabilities.js` and `index.js`;
// `lib/mcode-rpc.js` and `lib/acp-client.js` are reached through
// `await import()` inside the read — the M1 lesson, and the reason the
// route's own `await import(...)` lines moved behind this boundary
// rather than being duplicated.

import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * The declaration this endpoint needs: `null`, for the reason in the
 * header. The type keeps the `|null` branch so a future gated sibling
 * can be added to the same table without changing its shape.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "soft"}|null>>}
 */
export const CAPABILITY_READ_ENDPOINTS = Object.freeze({
  "GET /api/protocol/capabilities": null,
});

/**
 * Resolve the provider whose declaration answers the capability read on
 * `transport`.
 *
 * Unlike every other family this one ALWAYS answers, because an
 * empty capability view would be worse than useless for a capability
 * DETECTION endpoint: the frontend would learn nothing and could not
 * distinguish "no engine" from "this build has no declarations". So
 * when no provider claims the transport, the DEFAULT provider's
 * declaration is served and the descriptor says so.
 *
 * @param {string} transport
 * @returns {{provider: {id: string, transport: string, capabilities: object}, providerFor: "transport"|"default"}}
 */
export function resolveCapabilityReadProvider(transport) {
  const providerId = transport === "runtime" ? DEFAULT_ENGINE_PROVIDER_ID : null;
  if (providerId) {
    return { provider: getEngineProvider(providerId), providerFor: "transport" };
  }
  return { provider: getEngineProvider(), providerFor: "default" };
}

/**
 * Read the declaration for #73 WITHOUT enforcing it.
 *
 * Same `gate` vocabulary as `session-export.js#checkSessionExportCapability`
 * and `model-reads.js#checkModelReadCapability`, with one difference that
 * is forced by the `null` row: the result is always `no-capability-key`
 * and never `unregistered-transport`, because the provider this
 * endpoint serves is always resolvable (see
 * `resolveCapabilityReadProvider`).
 *
 * @param {string} endpoint  A key of CAPABILITY_READ_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: "soft"}}
 */
export function checkCapabilityReadCapability(endpoint, transport) {
  const need = CAPABILITY_READ_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkCapabilityReadCapability: "${endpoint}" is not part of the capability family ` +
        `(known: ${Object.keys(CAPABILITY_READ_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_capability_read_endpoint";
    throw err;
  }
  const { provider } = resolveCapabilityReadProvider(transport);
  return {
    endpoint,
    gate: "no-capability-key",
    provider: provider.id,
    capability: null,
    subItem: null,
    enforcement: "soft",
  };
}

/**
 * The engine-capabilities VIEW — the same four facts
 * `GET /api/engine-capabilities` serves, plus HOW the provider was
 * chosen.
 *
 * `providerFor` is the honest bit: `"transport"` means the active
 * transport's own provider answered; `"default"` means no provider
 * claims that transport yet (M4) and the default provider's
 * declaration is standing in. A capability-detection endpoint that
 * reported `"default"` as though it were `"transport"` would be
 * answering a question about a different engine than the one
 * connected — the same lie B1 declined for `/api/health` and B3
 * declined for #19, in the one place where it is most tempting because
 * the fallback is silent.
 *
 * @typedef {{
 *   provider: string,
 *   providerFor: "transport"|"default",
 *   transport: string,
 *   capabilities: object,
 *   unavailable: {none: string[], partial: Array<{key: string, missing: string[]}>},
 * }} EngineCapabilityView
 */

/**
 * The #73 (`GET /api/protocol/capabilities`) read.
 *
 * `wire` is `MCODE_ACP_CAPABILITIES` forwarded verbatim — the ACP
 * method table, NOT the engine declaration, and kept under its own
 * name in the response for exactly that reason. `agent` is the ACP
 * `initialize` mirror: `{version, name, title}` with the endpoint's own
 * `"unknown"` / `null` fallbacks, applied here so the route does not
 * repeat them.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint]   Endpoint key for the declaration
 *        check; defaults to `/api/protocol/capabilities`.
 * @param {string} [options.transport]  Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @returns {Promise<{engine: EngineCapabilityView, agent: {version: string, name: string|null, title: string|null}, wire: object, source: "declaration", gate: object, transport: string}>}
 */
export async function readEngineCapabilityView(options = {}) {
  const endpoint = options.endpoint || "GET /api/protocol/capabilities";
  const [rpc, acp, config, capabilities] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/acp-client.js"),
    import("../lib/config.js"),
    import("./capabilities.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = checkCapabilityReadCapability(endpoint, transport);
  const { provider, providerFor } = resolveCapabilityReadProvider(transport);
  // `initialize` answers with `agentInfo: {name, title, version}` (not
  // `serverInfo`); the mirror is empty until something attaches.
  const agentInfo = acp.getMcodeServerInfo();
  return {
    engine: {
      provider: provider.id,
      providerFor,
      transport: provider.transport,
      capabilities: provider.capabilities,
      unavailable: capabilities.summarizeUnavailableCapabilities(provider.capabilities),
    },
    agent: {
      version: (agentInfo && agentInfo.version) || "unknown",
      name: (agentInfo && agentInfo.name) || null,
      title: (agentInfo && agentInfo.title) || null,
    },
    wire: rpc.MCODE_ACP_CAPABILITIES,
    source: "declaration",
    gate,
    transport,
  };
}
