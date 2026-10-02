// webui/server/engine/session-tree-reads.js
//
// Migration step M3, batch B2: the session-tree read (树读) —
//
//   #8   GET /api/session-tree — the sidebar's Project → directory →
//                              session → subagent tree
//
// What this file is for. #8 is the main↔subagent communication spine: the
// hierarchy the user navigates is built from `parent_session_id`, and a
// child that fails to attach to its parent is a subagent the user cannot
// see. So the endpoint's payload is a frontend contract of the strictest
// kind here, and the route now reaches the engine through this file
// instead of calling `lib/session-tree.js` on its own: the facade checks
// the provider's DECLARATION first, then forwards to the one existing
// implementation. A provider that does not offer session listing answers
// 501 through `app.js#invokeHandler`'s EngineCapabilityNotSupportedError
// mapping rather than an empty tree, which the sidebar would render as
// "this project has no sessions" (#110 fake-success failure mode).
//
// What this file deliberately does NOT do:
//
//   - It does not re-assemble the tree. `lib/session-tree.js` owns the
//     level mapping (project / directory / branch / subagent), the
//     git-based project resolution and the 15s cache. A second
//     assembler here would be a second answer to a hierarchy question
//     that must have exactly one — and getting it wrong by one level is
//     precisely the failure this batch is gated on.
//   - It does not normalise nodes. The node shape
//     `{id, title, agent, kind, status, updatedAt, children}` is
//     whatever `buildTree` produces, byte-for-byte. Note what is NOT in
//     it: the response carries NO `parent_session_id` key. The hierarchy
//     is expressed structurally through `children`; `parent_session_id`
//     exists only inside the db read. `test/lib/engine/session-tree-reads.test.js`
//     pins the exact key set so a future "helpful" addition is caught.
//   - It does not construct a host. The tree is assembled from the
//     engine's own runtime db (see the source note below), so there is
//     no host in this path at all — see `Never build a second host`.
//   - It does not widen the engine's own degradation. A db that cannot
//     be read is still `{ok:false, reason}` with HTTP 200, exactly as
//     before; that is the sidebar's documented fallback to the wrapper
//     list, and the capability gate is a different question (may this
//     provider list sessions AT ALL) from "could we read the db right
//     now" (could we read it THIS TIME).
//
// Transport. Unlike the B1 read family, this read is deliberately
// transport-independent: it reads `local_runtime_sessions` in the
// runtime db, the engine's own persistent store, which both the
// `runtime` and the `acp` transport can see. `source` therefore
// reports `runtime-db` under every transport rather than pretending
// to be a catalogue answer. The DECLARATION check is still
// transport-keyed, because which provider is active is a transport
// question even when the read itself is not.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It therefore statically
// imports nothing heavier than `capabilities.js` and `index.js` (both
// pure declaration modules); `lib/session-tree.js` and `lib/config.js`
// are reached through `await import()` inside the functions. That split
// is the M1 lesson — putting the `@mavis/*` tree on the boot path once
// cost 209ms → 2700ms of server start and broke the integration tests'
// 3s window.
//
// Provider selection is M4's job, same as B1: `providerByTransport()`
// maps a transport to a REGISTERED provider id; today only `runtime` has
// one, so under the default `acp` transport the gate reports
// `gate: "unregistered-transport"` instead of inventing one.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`, which this mirrors rather than
 * merges: the two families have separate gate semantics (see
 * `session-export.js` for the soft-gate counterpart) and a shared table
 * would force one of them to inherit the other's policy.
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
 * `sessionCrud` / `listSessions` is the honest mapping, and it is the
 * same pair B1's `GET /api/protocol/list-sessions` uses: both endpoints
 * answer "every session the engine knows, across all workspaces", and
 * the tree is that list plus a hierarchy. The tree additionally needs
 * the `parent_session_id` column, but that is not a separate
 * provider method — it is a column of the same rows, so naming a
 * sub-item that no provider enumerates would be a lie in the registry.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string}>>}
 */
export const SESSION_TREE_ENDPOINTS = Object.freeze({
  "GET /api/session-tree": { capability: "sessionCrud", subItem: "listSessions" },
});

/**
 * Resolve the provider that answers the tree read on `transport`, or
 * `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionTreeProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Check the tree read against the active provider's declaration. Throws
 * `EngineCapabilityNotSupportedError` — which `app.js#invokeHandler`
 * turns into 501 — when the declaration says the capability (or the
 * exact sub-item) is absent.
 *
 * @param {string} endpoint  A key of SESSION_TREE_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null}}
 */
export function assertSessionTreeCapability(endpoint, transport) {
  const need = SESSION_TREE_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation — a plain Error so the
    // HTTP layer never answers 501 for a typo in webui's own code.
    const err = new Error(
      `assertSessionTreeCapability: "${endpoint}" is not part of the session-tree family ` +
        `(known: ${Object.keys(SESSION_TREE_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_tree_endpoint";
    throw err;
  }
  const provider = resolveSessionTreeProvider(transport);
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
 * Lazily resolve the session-tree module and the active transport.
 * Dynamic on both counts: `lib/session-tree.js` reaches the sqlite
 * resolver and the settings chain, `lib/config.js` reads env — neither
 * may sit on the boot path.
 */
async function treeDeps() {
  const [tree, config] = await Promise.all([
    import("../lib/session-tree.js"),
    import("../lib/config.js"),
  ]);
  return { tree, transport: config.MCODE_WEBUI_TRANSPORT };
}

/**
 * Where the tree's bytes came from. Always `runtime-db`: the tree is
 * assembled from `local_runtime_sessions` in the engine's own runtime
 * db, which is not a transport-switched surface (see the transport note
 * in the file header). The value exists so a consumer never has to
 * guess whether the ACP mirror answered instead.
 *
 * @typedef {"runtime-db"} SessionTreeSource
 */

/**
 * The #8 (`GET /api/session-tree`) read.
 *
 * Forwards `options` straight to `getSessionTree`, so `force` keeps its
 * meaning (`?refresh=1` bypasses the 15s cache) and the `cached` field
 * keeps its shape. The returned `tree` is the endpoint's payload
 * verbatim — including the `ok:false` / `reason` soft-fail shape for a
 * missing or unreadable db, which this facade deliberately does not
 * convert into an error.
 *
 * @param {object} [options]
 * @param {boolean} [options.force]    Bypass the 15s cache.
 * @param {string}  [options.endpoint] Endpoint key for the declaration
 *        check; defaults to `/api/session-tree`.
 * @param {string}  [options.now]      Clock injection, forwarded as-is.
 * @param {string}  [options.transport] Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`. Exists so tests can exercise
 *        both the `runtime` and the unregistered `acp` branch without
 *        mutating process env.
 * @returns {Promise<{tree: object, source: SessionTreeSource, gate: object, transport: string}>}
 */
export async function readEngineSessionTree(options = {}) {
  const endpoint = options.endpoint || "GET /api/session-tree";
  const deps = await treeDeps();
  const transport = options.transport || deps.transport;
  const gate = assertSessionTreeCapability(endpoint, transport);
  const tree = deps.tree.getSessionTree({
    force: options.force === true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { tree, source: "runtime-db", gate, transport };
}
