// webui/server/engine/session-reads.js
//
// Migration step M3, batch B1: the directory-read family (目录读族) —
// the five endpoints that only ever ASK the engine what it knows:
//
//   #9   GET /api/acp-sessions        — sidebar session list (cwd filtered)
//   #10  GET /api/acp-session-title   — one session's title
//   #72  GET /api/protocol/list-sessions — remote-control session list (all)
//   #74  GET /api/state               — snapshot, mcodeSessions mirror source
//   #75  GET /api/health              — engine version, /api/state sibling
//
// What this file is for. Before M3 a route asked the ACP client directly
// and inherited whatever the transport happened to be. After M3 the route
// asks the facade, the facade checks the provider's DECLARATION first, and
// a provider that does not offer the read answers 501 through
// `invokeHandler`'s `EngineCapabilityNotSupportedError` mapping instead of
// quietly returning `[]` (the #110 fake-success failure mode).
//
// What this file deliberately does NOT do:
//
//   - It does not re-implement listing. `lib/acp-client.js` already owns
//     the transport switch and already normalises the catalogue host's
//     `TuiSession` through `lib/catalogue-sessions.js#projectTuiSessionToAcp`
//     — the one normalizer whose output is the ACP `session/list` wire
//     shape the sidebar tree speaks. A second normalizer here would be a
//     second answer to a shape question that must have exactly one.
//   - It does not construct a host. `getCatalogueHost()` is the process
//     singleton; this module only forwards to it (see `Never build a
//     second host`).
//   - It does not build a host-shaped error of its own for "the engine
//     could not boot": a read family that fails over to the ACP mirror
//     reports WHERE the bytes came from (`source`) instead of pretending
//     the engine answered. Only endpoints whose whole contract is the
//     engine (plugins / turn-diff) answer `RUNTIME_UNAVAILABLE`.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It therefore statically imports
// nothing heavier than `capabilities.js` and `index.js` (both pure
// declaration modules); `lib/acp-client.js` and `lib/config.js` are
// reached through `await import()` inside the functions. That split is the
// M1 lesson — putting the `@mavis/*` tree on the boot path once cost
// 209ms → 2700ms of server start and broke the integration tests' 3s
// window.
//
// Provider selection is M4's job. `providerByTransport()` maps a transport
// to a REGISTERED provider id; today only `runtime` has one, so under the
// default `acp` transport there is no declaration to check and the gate
// reports `gate: "unregistered-transport"` instead of inventing one. When
// M4 registers the ACP provider this table gains its entry and the gate
// starts answering for the default transport too.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose: a missing provider answer is the
 * pre-M4 passthrough, an unsupported capability answer is 501.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its temporal
 * dead zone on a cold `import("./engine/index.js")` — the evaluation order
 * of a re-export is the importer's, not this module's. Every consumer of
 * the table is a function anyway.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * The declaration each endpoint in this family needs, and the sub-item it
 * needs from that capability. `subItem` is the provider method the route
 * ultimately depends on, so a `partial` declaration that omits exactly that
 * method yields 501 naming the method rather than a generic refusal.
 *
 * `/api/health` is `null`: reading the engine's own version is not any of
 * the 14 matrix keys (`updateCheck` is about checking for a NEW version,
 * not reporting the installed one), and inventing a key here would put a
 * lie in the capability registry. See `readEngineVersion` for what the
 * endpoint does instead.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string}|null>>}
 */
export const SESSION_READ_ENDPOINTS = Object.freeze({
  "GET /api/acp-sessions": { capability: "sessionCrud", subItem: "listSessions" },
  "GET /api/acp-session-title": { capability: "sessionCrud", subItem: "getSession" },
  "GET /api/protocol/list-sessions": { capability: "sessionCrud", subItem: "listSessions" },
  "GET /api/state": { capability: "sessionCrud", subItem: "listSessions" },
  "GET /api/health": null,
});

/**
 * Resolve the provider that answers catalogue reads on `transport`, or
 * `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionReadProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Check one endpoint of this family against the active provider's
 * declaration. Throws `EngineCapabilityNotSupportedError` — which
 * `app.js#invokeHandler` turns into 501 — when the declaration says the
 * capability (or the exact sub-item) is absent.
 *
 * @param {string} endpoint  A key of SESSION_READ_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null}}
 */
export function assertSessionReadCapability(endpoint, transport) {
  const need = SESSION_READ_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation — a plain Error so the
    // HTTP layer never answers 501 for a typo in webui's own code.
    const err = new Error(
      `assertSessionReadCapability: "${endpoint}" is not part of the session-read family ` +
        `(known: ${Object.keys(SESSION_READ_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_read_endpoint";
    throw err;
  }
  const provider = resolveSessionReadProvider(transport);
  if (need === null) {
    return {
      endpoint,
      gate: "no-capability-key",
      provider: provider ? provider.id : null,
      capability: null,
      subItem: null,
    };
  }
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Where a list read's bytes actually came from. `catalogue` means the
 * in-process host answered (and went through `catalogue-sessions.js`);
 * `acp` means the `mcode acp` subprocess answered; `acp-fallback` means
 * the transport ASKED for the catalogue host and the host was null, so the
 * ACP mirror answered instead — reported rather than hidden, because a
 * sidebar that silently loses its runtime path is exactly the degradation
 * this batch exists to make visible.
 *
 * @typedef {"catalogue" | "acp" | "acp-fallback"} SessionReadSource
 */

/**
 * Lazily resolve the acp-client module and the active transport. Dynamic
 * on both counts: `lib/acp-client.js` pulls `acp.mjs` and the settings
 * chain, `lib/config.js` reads env — neither may sit on the boot path.
 */
async function readDeps() {
  const [acp, config] = await Promise.all([
    import("../lib/acp-client.js"),
    import("../lib/config.js"),
  ]);
  return { acp, transport: config.MCODE_WEBUI_TRANSPORT };
}

/**
 * Did the catalogue host answer on this transport? Returns `false` when
 * the transport never wanted the catalogue, and also when it wanted it but
 * the host failed to boot (the `acp-fallback` case).
 */
async function catalogueAnswered(acp, transport) {
  if (transport !== "runtime") return false;
  const host = await acp.getCatalogueHost();
  return host !== null && host !== undefined;
}

/**
 * Every session the engine knows, across all workspaces — the #72
 * (`/api/protocol/list-sessions`) read. The caller applies its own cwd
 * filter, exactly as the endpoint did before, so the filtering rule and
 * the response shape stay in one place.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint] Endpoint key for the declaration
 *        check; defaults to `/api/protocol/list-sessions`.
 * @returns {Promise<{sessions: Array<object>, source: SessionReadSource, gate: object, transport: string}>}
 */
export async function readEngineSessionList(options = {}) {
  const endpoint = options.endpoint || "GET /api/protocol/list-sessions";
  const { acp, transport } = await readDeps();
  const gate = assertSessionReadCapability(endpoint, transport);
  const answered = await catalogueAnswered(acp, transport);
  return {
    sessions: await acp.listAllMcodeSessions(),
    source: transport !== "runtime" ? "acp" : answered ? "catalogue" : "acp-fallback",
    gate,
    transport,
  };
}

/**
 * The workspace-filtered session list — the #9 (`/api/acp-sessions`) and
 * #74 (`/api/state` `mcodeSessions` mirror) read. Same 30s cache and same
 * path normalisation as before, because the call goes to the same
 * `getMcodeSessionsForWorkspace`.
 *
 * @param {object} options
 * @param {string} [options.cwd]      Workspace to filter by; empty means
 *                                     "no filter" and the caller decides.
 * @param {string} [options.endpoint] Endpoint key for the declaration
 *        check; defaults to `/api/acp-sessions`.
 * @returns {Promise<{sessions: Array<object>, source: SessionReadSource, gate: object, transport: string}>}
 */
export async function readEngineSessionListForWorkspace(options = {}) {
  const endpoint = options.endpoint || "GET /api/acp-sessions";
  const { acp, transport } = await readDeps();
  const gate = assertSessionReadCapability(endpoint, transport);
  const answered = await catalogueAnswered(acp, transport);
  const sessions = await acp.getMcodeSessionsForWorkspace(options.cwd || "");
  return {
    sessions,
    source: transport !== "runtime" ? "acp" : answered ? "catalogue" : "acp-fallback",
    gate,
    transport,
  };
}

/**
 * One session's title — the #10 (`/api/acp-session-title`) read. `null`
 * for "no such session" and `null` for "engine has no title", which is the
 * contract the endpoint has always had; the bridge does not merge them.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @returns {Promise<{sessionId: string, title: string|null, source: SessionReadSource, gate: object, transport: string}>}
 */
export async function readEngineSessionTitle(options = {}) {
  const { acp, transport } = await readDeps();
  const gate = assertSessionReadCapability("GET /api/acp-session-title", transport);
  const answered = await catalogueAnswered(acp, transport);
  const sessionId = options.sessionId || "";
  return {
    sessionId,
    title: sessionId ? await acp.getMcodeSessionTitle(sessionId) : null,
    source: transport !== "runtime" ? "acp" : answered ? "catalogue" : "acp-fallback",
    gate,
    transport,
  };
}

/**
 * The engine's installed version — the #75 (`/api/health`) read.
 *
 * The one honest answer available today comes from the ACP `initialize`
 * reply's `agentInfo.version`; the in-process catalogue host exposes no
 * version accessor (its surface is `adapter` / `cliService` / `apiHost` /
 * `controller` / `application` / `applications`, see
 * `providers/local-runtime-v2.js`), so "read it from the v2 host" as the
 * batch plan imagined is not implementable without inventing a method.
 * Rather than fabricate one, the bridge names the source it used and
 * keeps the endpoint's `"unknown"` fallback for "nothing has attached
 * yet". The shape of `/api/health` is untouched.
 *
 * @returns {Promise<{version: string, source: SessionReadSource, transport: string, gate: object}>}
 */
export async function readEngineVersion() {
  const { acp, transport } = await readDeps();
  const gate = assertSessionReadCapability("GET /api/health", transport);
  const info = acp.getMcodeServerInfo();
  return {
    version: (info && info.version) || "unknown",
    // The version is a protocol fact, not a catalogue fact: it is answered
    // from the ACP `initialize` mirror under every transport, including
    // `runtime`, where the mirror is simply empty until something attaches.
    source: "acp",
    transport,
    gate,
  };
}
