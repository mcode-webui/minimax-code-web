// webui/server/engine/session-export.js
//
// Migration step M3, batch B2: the export enrichment read (导出增强读) —
//
//   #11  GET /api/sessions/:id/export?format=md|json
//
// What this file is for. Export is the ONE endpoint in this migration
// whose primary data source is webui's own store, not the engine: the
// conversation comes from `lib/sessions.js` (`sessions.json`), and the
// route parses it with its own line grammar and renders md/json. The
// engine's only contribution is the transcript enrichment
// (`readMcodeTranscript`), which the route has always treated as
// BEST-EFFORT — "If the db is unreadable / the table is missing / the
// schema differs, we set `_meta.mcode_unavailable` and continue with the
// webui source — never block export". This file moves that one
// engine-facing read behind the facade so the route stops naming
// `lib/transcript.js` directly, and so the place where the enrichment
// can fail is stated once, in the engine layer, instead of being implied
// by control flow in a route.
//
// Why this family has a SOFT gate and the tree family has a HARD one.
// This is the one place where copying B1's shape verbatim would have
// been wrong, so the difference is deliberate and load-bearing:
//
//   - #8 session-tree is 100% engine data. No session listing, no tree.
//     Answering `501` is the only honest response, and the endpoint
//     already had a documented "cannot read" shape to fall back on.
//   - #11 export is mostly NOT engine data. A provider that declared
//     `sessionCrud: none` would still leave the full user-visible chat
//     exportable from `sessions.json`. Gating the endpoint hard would
//     REMOVE working functionality in response to a declaration about a
//     capability the endpoint does not actually depend on — and it would
//     break the explicit "never block export" contract, which is this
//     repository's #110 discipline applied in the other direction: a
//     missing enrichment must not be dressed up as a failure, and a
//     missing capability must not be dressed up as one either.
//
// So the gate here REPORTS and never throws. `checkSessionExportCapability`
// answers what the provider declared, and the read degrades through the
// endpoint's own pre-existing fail-soft channel
// (`_meta.mcode_unavailable` + `mcode_unavailable_reason`) rather than
// through an HTTP status. The 501 machinery in `errors.js` stays
// untouched and unused by this family — that is a policy statement, not
// an oversight, and the test suite pins it.
//
// What this file deliberately does NOT do:
//
//   - It does not own the export. Parsing webui chat lines, merging the
//     two message sources, and rendering md/json are the route's job and
//     stay there; they are presentation, not engine access. Only the
//     transcript read crosses this seam.
//   - It does not own the session lookup. `_findSession` resolves a
//     webui id or an `mvs_` id against `sessions.json` — webui's own
//     store, governed by no engine capability.
//   - It does not construct a host.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It statically imports nothing
// heavier than `capabilities.js` and `index.js`; `lib/transcript.js`
// and `lib/config.js` are reached through `await import()` inside the
// functions — the M1 lesson again.
//
// Provider selection is M4's job, same as B1 and as the tree family.

import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Same shape and same
 * rationale as `session-reads.js#providerByTransport` and
 * `session-tree-reads.js#providerByTransport`; kept per-family so each
 * family owns its own gate policy. Collapse the three in M4, not here.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
 * temporal dead zone on a cold `import("./engine/index.js")`.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * The declaration this endpoint's ENRICHMENT needs.
 *
 * `sessionCrud` / `getSession` is the honest mapping — the same pair
 * B1's `GET /api/acp-session-title` uses, because reading a session's
 * transcript is reading that session. It is the ENRICHMENT that is
 * declared, not the export: see the soft-gate rationale in the header.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "soft"}>>}
 */
export const SESSION_EXPORT_ENDPOINTS = Object.freeze({
  "GET /api/sessions/:id/export": {
    capability: "sessionCrud",
    subItem: "getSession",
    enforcement: "soft",
  },
});

/**
 * Resolve the provider that answers export enrichment on `transport`,
 * or `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionExportProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Read the declaration for this endpoint WITHOUT enforcing it.
 *
 * Returns a descriptor whose `gate` field says what happened:
 *
 *   - `"checked"`           — provider resolved, capability is `full`.
 *   - `"unregistered-transport"` — no provider claims this transport yet.
 *   - `"capability-absent"` — the provider WAS found and DOES declare the
 *     capability as `none` (or `partial` missing this sub-item). This is
 *     the branch that makes the soft gate visible: the caller's next
 *     move is to degrade the ENRICHMENT, not to fail the request.
 *   - `"partial"`           — provider is `partial` and this sub-item is
 *     absent; the endpoint still degrades, but the descriptor says so
 *     precisely.
 *
 * Deliberately never throws `EngineCapabilityNotSupportedError`. A
 * caller that wants the hard behaviour (the tree family) must ask for
 * it explicitly; that asymmetry is the point of splitting the two.
 * A genuinely unknown endpoint key is still a plain Error — caller
 * confusion is not a capability question.
 *
 * @param {string} endpoint  A key of SESSION_EXPORT_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: "soft"}}
 */
export function checkSessionExportCapability(endpoint, transport) {
  const need = SESSION_EXPORT_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkSessionExportCapability: "${endpoint}" is not part of the session-export family ` +
        `(known: ${Object.keys(SESSION_EXPORT_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_export_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveSessionExportProvider(transport);
  if (!provider) return { ...base, gate: "unregistered-transport" };
  const entry = provider.capabilities ? provider.capabilities[need.capability] : undefined;
  const descriptor = { ...base, provider: provider.id };
  if (entry && entry.level === "full") {
    return { ...descriptor, gate: "checked" };
  }
  if (entry && entry.level === "partial") {
    const absent = Array.isArray(entry.missing) && entry.missing.includes(need.subItem);
    return { ...descriptor, gate: absent ? "partial" : "checked" };
  }
  // `none`, or no entry at all — the provider was found and does not
  // offer this. Report it; the caller degrades the enrichment.
  return { ...descriptor, gate: "capability-absent" };
}

/**
 * Lazily resolve the transcript module and the active transport.
 * Dynamic: `lib/transcript.js` reaches the sqlite resolver and the
 * settings chain, neither of which may sit on the boot path.
 */
async function exportDeps() {
  const [transcript, config] = await Promise.all([
    import("../lib/transcript.js"),
    import("../lib/config.js"),
  ]);
  return { transcript, transport: config.MCODE_WEBUI_TRANSPORT };
}

/**
 * Where the enrichment's bytes came from. `engine` when the transcript
 * reader answered; `none` when it did not (and the caller degrades).
 *
 * @typedef {"engine" | "none"} SessionExportSource
 */

/**
 * The #11 engine-facing read: one session's transcript, best-effort.
 *
 * The returned `ok` / `reason` / `messages` are `readMcodeTranscript`'s
 * own values, forwarded verbatim — this facade never invents a reason
 * code and never converts a failure into an exception, because the
 * endpoint's `_meta.mcode_unavailable` / `mcode_unavailable_reason`
 * contract is built on those exact strings. `probeTable` and `probe`
 * are the reader's own `source` / `probe`, renamed so they cannot be
 * confused with this layer's `source`.
 *
 * Async even though the reader is synchronous (better-sqlite3 is sync):
 * the route is already async, and a uniform awaitable `readEngine*`
 * seam means a provider-backed transcript source that IS async (a
 * network engine) needs no signature change at this layer.
 *
 * @param {object} [options]
 * @param {string} [options.mcodeSessionId] The `mvs_…` id to read.
 * @param {string} [options.endpoint]       Endpoint key for the
 *        declaration check; defaults to `/api/sessions/:id/export`.
 * @param {string} [options.transport]      Transport override; defaults
 *        to the active `MCODE_WEBUI_TRANSPORT`.
 * @returns {Promise<{mcodeSessionId: string, messages: Array<object>, ok: boolean, reason: string|null, probeTable: string|null, probe: string|null, source: SessionExportSource, gate: object, transport: string}>}
 */
export async function readEngineSessionTranscript(options = {}) {
  const endpoint = options.endpoint || "GET /api/sessions/:id/export";
  const deps = await exportDeps();
  const transport = options.transport || deps.transport;
  const gate = checkSessionExportCapability(endpoint, transport);
  const mcodeSessionId = options.mcodeSessionId || "";
  const r = deps.transcript.readMcodeTranscript(mcodeSessionId);
  return {
    mcodeSessionId,
    messages: Array.isArray(r.messages) ? r.messages : [],
    ok: r.ok === true,
    reason: r.ok === true ? null : r.reason || "unknown",
    probeTable: r.source || null,
    probe: r.probe || null,
    source: r.ok === true ? "engine" : "none",
    gate,
    transport,
  };
}
