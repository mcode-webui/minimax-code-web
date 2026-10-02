// webui/server/engine/account-reads.js
//
// Migration step M3, batch B4: the account read (账户读) —
//
//   #20  GET /api/account — the account card's identity / plan-tier data
//
// What this file is for. #20 is a small endpoint with a strict privacy
// contract: the payload is the user's own display name, plan tier and
// quota, it is fetched ON DEMAND rather than pushed into the state
// snapshot (the snapshot is broadcast to every SSE subscriber, LAN
// included), and the engine's projection carries no credential. The
// route therefore has to stay a one-liner that writes a body and never
// accumulates identity state — and that is exactly what a facade read
// gives it. After M3-B4 the route asks this file, this file asks the
// provider whether it may, and only then forwards to
// `lib/mcode-rpc.js#getAccountStatus`.
//
// Why the gate is HARD here while #57 and #73 are not. This endpoint is
// 100% engine data: there is no webui-side fallback for "who am I" and
// no webui-side fallback for the plan tier. The empty state the card
// renders when the engine cannot be reached is a RUNTIME outcome
// (HTTP 200 + `{ok:false, reason}`), which this file preserves
// verbatim; a provider that declares no `getAccountStatus` is a
// different, structural outcome, and the only honest answer to it is
// the 501 that `app.js#invokeHandler` derives from
// `EngineCapabilityNotSupportedError`. Same rule, same pair, same
// provider method as B3's `POST /api/usage` / `POST /api/usage-trigger`
// — the usage popover and the account card read the SAME engine
// projection through the SAME `mcode/account/status` extension method,
// so a declaration that removes it must take both down together. Two
// modules, not one: the usage family owns the quota DERIVATIONS
// (`contextUsedTokens`, the least-squares forecast) and the usage
// family has its own gate policy for #19; merging them would force one
// to inherit the other's.
//
// What this file deliberately does NOT do:
//
//   - It does not reshape the engine's projection. `r.data` is spread
//     into the response verbatim (`{ok:true, ...r.data}`), so a new
//     engine field reaches the card without a webui edit, and an
//     absent one does not become a `null` this layer invented.
//   - It does not invent a reason. The failure body is
//     `{ok:false, reason: r.code || "account_unavailable"}` — the
//     endpoint's own fallback, kept byte-for-byte. The account card
//     (`webapp/components/shell.tsx#SidebarFooter`) renders its
//     本地用户 placeholder on any failure, and it must keep doing so
//     for the engine-could-not-be-reached case that has always produced
//     it.
//   - It does not construct a host. `getAccountStatus` goes through the
//     process-singleton ACP client, the same path it has always taken.
//   - It does not log the payload. Identity data must not reach a log
//     line; the only logging this path can do is whatever
//     `mcode-rpc.js#sanitizeError` already does to an error string.
//
// Boot-path weight. `app.js` imports `routes/account.js`, the route
// imports this file, so this file is on the boot path. It statically
// imports nothing heavier than `capabilities.js` and `index.js` (both
// pure declaration modules); `lib/mcode-rpc.js` and `lib/config.js` are
// reached through `await import()` inside the read. That split is the
// M1 lesson — putting the `@mavis/*` tree on the boot path once cost
// 209ms → 2700ms of server start and broke the integration tests' 3s
// window.
//
// Provider selection is M4's job, same as B1, B2 and B3:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// today only `runtime` has one, so under the default `acp` transport the
// gate reports `gate: "unregistered-transport"` and the read proceeds —
// which is correct, because the pre-M4 behaviour under `acp` is the
// only behaviour this endpoint has ever had.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`,
 * `session-tree-reads.js#providerByTransport` and
 * `usage-reads.js#providerByTransport`, which this mirrors rather than
 * merges: the four families have separate read contracts and a shared
 * table would force one of them to inherit another's policy.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
 * temporal dead zone on a cold `import("./engine/index.js")`. Every
 * consumer of the table is a function anyway.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * The declaration this endpoint needs, and the sub-item it needs from
 * that capability.
 *
 * `authCredentials` / `getAccountStatus` is the honest mapping, and it
 * is deliberately the SAME pair `usage-reads.js` uses for #15 / #16:
 * both endpoints read the engine's own account projection through the
 * `mcode/account/status` extension method, so they depend on the same
 * provider method and must be gated by the same declaration. Naming a
 * different sub-item here would let a `partial` provider drop
 * `getAccountStatus` from the account card while the usage popover
 * still claimed to have it.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string}>>}
 */
export const ACCOUNT_READ_ENDPOINTS = Object.freeze({
  "GET /api/account": { capability: "authCredentials", subItem: "getAccountStatus" },
});

/**
 * Resolve the provider that answers the account read on `transport`, or
 * `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveAccountReadProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Check the account read against the active provider's declaration.
 * Throws `EngineCapabilityNotSupportedError` — which
 * `app.js#invokeHandler` turns into 501 — when the declaration says
 * the capability (or the exact sub-item) is absent.
 *
 * @param {string} endpoint  A key of ACCOUNT_READ_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null}}
 */
export function assertAccountReadCapability(endpoint, transport) {
  const need = ACCOUNT_READ_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation — a plain Error so the
    // HTTP layer never answers 501 for a typo in webui's own code.
    const err = new Error(
      `assertAccountReadCapability: "${endpoint}" is not part of the account family ` +
        `(known: ${Object.keys(ACCOUNT_READ_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_account_read_endpoint";
    throw err;
  }
  const provider = resolveAccountReadProvider(transport);
  if (!provider) {
    return {
      endpoint,
      gate: "unregistered-transport",
      provider: null,
      capability: need.capability,
      subItem: need.subItem,
    };
  }
  assertEngineCapability(provider.capabilities, need.capability, provider.id, need.subItem);
  return {
    endpoint,
    gate: "checked",
    provider: provider.id,
    capability: need.capability,
    subItem: need.subItem,
  };
}

/**
 * Where the account bytes came from. Always `account-status`: the read
 * is the engine's `mcode/account/status` extension method, reached
 * through the ACP client, under every transport. The value exists so a
 * consumer never has to guess whether a webui-side fallback answered —
 * there is none, and saying so in a field is cheaper than a reader
 * assuming one.
 *
 * @typedef {"account-status"} AccountReadSource
 */

/**
 * The #20 (`GET /api/account`) read.
 *
 * `payload` IS the endpoint's response body, built here once so the
 * route is a single `res.end(JSON.stringify(payload))` and the body has
 * exactly one home:
 *
 *   - success → `{ok:true, ...(r.data || {})}`. The engine's projection
 *     is spread verbatim, so `identity` / `tokenPlan` / any future field
 *     arrive exactly as the engine framed them, and an engine that
 *     answers `{ok:true, data:null}` still produces `{ok:true}` rather
 *     than a `TypeError` on the spread.
 *   - failure → `{ok:false, reason: r.code || "account_unavailable"}`.
 *     Soft by contract: the REQUEST succeeded, so the status stays 200
 *     and the card renders its empty state. `r.code` is preferred
 *     because it is the engine's own machine-readable reason
 *     (`no_client`, `unauthorized`, …); the string fallback is the
 *     endpoint's own and predates every code.
 *
 * @param {object} [options]
 * @param {object} [options.cs]   The webui client state; only
 *        `cs.mcodeSessionId` is read, exactly as the route read it.
 * @param {string} [options.endpoint]   Endpoint key for the declaration
 *        check; defaults to `/api/account`.
 * @param {string} [options.transport]  Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`. Exists so tests can exercise both
 *        the `runtime` and the unregistered `acp` branch without mutating
 *        process env.
 * @returns {Promise<{payload: object, source: AccountReadSource, gate: object, transport: string}>}
 */
export async function readEngineAccount(options = {}) {
  const endpoint = options.endpoint || "GET /api/account";
  const [rpc, config] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertAccountReadCapability(endpoint, transport);
  // `cs && cs.mcodeSessionId` is forwarded EXACTLY as the route used to
  // compute it, including the `undefined` a missing ctx produces —
  // `getAccountStatus` turns any falsy id into `{}`, and a test that
  // pins the forwarded argument must see the same value the route sent.
  const r = await rpc.getAccountStatus(options.cs && options.cs.mcodeSessionId);
  const payload = r && r.ok
    ? { ok: true, ...(r.data || {}) }
    : { ok: false, reason: (r && r.code) || "account_unavailable" };
  return { payload, source: "account-status", gate, transport };
}
