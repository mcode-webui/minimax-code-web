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
// disagree, with no test able to notice. After M3-B4 `capabilities` IS
// the engine-capabilities view: the route no longer reaches into
// `lib/mcode-rpc.js` and `lib/acp-client.js` on its own, and there is
// one answer rather than two.
//
// The ACP wire table is REPLACED, not kept alongside — a reviewed,
// user-authorised endpoint contract change, not a refactor side effect.
// `MCODE_ACP_CAPABILITIES` described a different taxonomy (which ACP
// JSON-RPC method exists) and it had drifted into being the endpoint's
// headline field while nothing in the webapp read it. Carrying both
// would have meant the 14-key declaration appeared twice in one
// response, once as the answer and once as a decoration, so the extra
// `engine` key this batch first shipped was removed rather than kept.
// What survives from that first shape is the honest provenance — which
// provider answered, and whether it was standing in — hoisted to
// `capabilitiesProvider` / `capabilitiesProviderFor`.
//
// KNOWN DEBT, recorded rather than acted on: `MCODE_ACP_CAPABILITIES`
// in `lib/mcode-rpc.js` now has no consumer. It is still exported and
// still pinned by `test/lib/mcode-rpc.check.mjs`, and `docs/CAPABILITIES.md`
// cites it as a fact about the ENGINE's ACP surface (which it still
// is), so deleting it is a separate decision about dead code, not a
// side effect of replacing a response field. `test/helpers/_setup.js`
// mirrors the export for the same reason.
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
// `lib/acp-client.js` and `lib/config.js` are reached through
// `await import()` inside the read — the M1 lesson, and the reason the
// route's own `await import(...)` lines moved behind this boundary
// rather than being duplicated. (`lib/mcode-rpc.js` was in that list
// while the endpoint still served the ACP wire table; replacing the
// field removed the dependency, not just the field.)

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
 * How the declaration that answered was chosen.
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
 * }} EngineCapabilityProvenance
 */

/**
 * The #73 (`GET /api/protocol/capabilities`) read.
 *
 * `declaration` is the provider's 14-key capability object FORWARDED BY
 * IDENTITY — not a copy, not a re-projection. A copy would be a second
 * thing that can drift from the reviewed declaration, which is the whole
 * failure this endpoint had before M3-B4.
 *
 * `unavailable` is the DERIVED roll-up (`summarizeUnavailableCapabilities`)
 * and is the one field here that is not the declaration itself: a
 * `none` key means hide the entry point, a `partial` key means hide or
 * disable exactly the listed sub-actions (design §4.2). It is kept
 * because it is the shape the capability-driven UI renders from, and a
 * consumer should not have to re-derive it from a taxonomy that has
 * three levels and two optional fields.
 *
 * `agent` is the ACP `initialize` mirror: `{version, name, title}` with
 * the endpoint's own `"unknown"` / `null` fallbacks, applied here so
 * the route does not repeat them.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint]   Endpoint key for the declaration
 *        check; defaults to `/api/protocol/capabilities`.
 * @param {string} [options.transport]  Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @returns {Promise<{declaration: object, unavailable: {none: string[], partial: Array<{key: string, missing: string[]}>}, provider: string, providerFor: "transport"|"default", engineTransport: string, agent: {version: string, name: string|null, title: string|null}, source: "declaration", gate: object, transport: string}>}
 */
export async function readEngineCapabilityView(options = {}) {
  const endpoint = options.endpoint || "GET /api/protocol/capabilities";
  const [acp, config, capabilities] = await Promise.all([
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
    declaration: provider.capabilities,
    unavailable: capabilities.summarizeUnavailableCapabilities(provider.capabilities),
    provider: provider.id,
    providerFor,
    // The PROVIDER's wire form, named apart from the ambient
    // `transport` the read ran under: under the default `acp` transport
    // the declaration served belongs to a `runtime` provider, and
    // collapsing the two into one field would say exactly the thing
    // `providerFor` exists to prevent.
    engineTransport: provider.transport,
    agent: {
      version: (agentInfo && agentInfo.version) || "unknown",
      name: (agentInfo && agentInfo.name) || null,
      title: (agentInfo && agentInfo.title) || null,
    },
    source: "declaration",
    gate,
    transport,
  };
}
