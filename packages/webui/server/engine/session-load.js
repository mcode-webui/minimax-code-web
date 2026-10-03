// webui/server/engine/session-load.js
//
// Migration step M3, batch B7 (part 2 of 2): the LOAD and ACTIVATE
// family —
//
//   #70  POST /api/protocol/load-session     — make the engine load a session
//   #71  POST /api/protocol/activate-session  — point the client at a session
//
// What this file is for. Both endpoints end by mutating webui's own
// state, and before M3 that mutation — the sidebar entry, the
// `mcodeSessionId` rebinding, the context reset, the response body —
// was assembled in `routes/protocol.js`, which reached into
// `lib/mcode-rpc.js#loadSession` / `#activateSession` and
// `lib/sessions.js#loadSessions` / `#saveSessions` / `#resetContext`
// directly. Three facts about that work are load-bearing and none of
// them is visible from the route's edge any more:
//
//   1. #70's SIDEBAR ENTRY IS DOWNSTREAM OF THE ENGINE'S ANSWER, NEVER A
//      PEER OF IT. `createWebuiEntry` adds a record to `sessions.json`
//      so the sidebar can show a session the TUI started — but it may
//      only be created once the engine has confirmed the load. A
//      provider that cannot load must not be able to leave a sidebar
//      entry pointing at a session the engine never opened, and a
//      failed load must not leave one either. This is the invariant that
//      decides #70's gate (see below), and it is why the entry creation
//      is ordered strictly after the capability check and the engine
//      call rather than being a parallel "best effort" branch.
//
//   2. THE ENTRY IS IDEMPOTENT, AND IDEMPOTENCE IS ABOUT THE
//      `mcodeSessionId` MATCH, NOT THE CALLER. A second
//      `createWebuiEntry` for a session webui already wraps returns the
//      EXISTING record without re-saving, so repeated calls cannot grow
//      duplicate sidebar entries for one conversation. This is
//      pre-existing behaviour and the suite pins both halves (first
//      call creates, second call returns the same id and does not grow
//      the store).
//
//   3. #71's ORDER IS `mcodeSessionId` FIRST, `resetContext` SECOND.
//      `resetContext` re-roots the context panel from the client state,
//      so it has to observe the NEW session id — reversing the two
//      leaves the panel describing the session the user just left. The
//      pair is also the endpoint's entire meaning, which is why the
//      response is built here next to it and never re-assembled.
//
// Why this family's gate is SPLIT, and why the split is not a
// compromise between two opinions.
//
// Both endpoints declare the same capability — `sessionCrud`, the same
// key B1 uses for the title read and B5 uses for the delete — but they
// need different answers to "if the provider declares this absent, can
// the endpoint still serve a truthful answer?", and the two answers are
// not close:
//
//   - #70 GATES HARD. Its only purpose is to make the engine load a
//     session; there is no webui-side fallback, and by fact 1 a
//     "success" that skipped the engine would write a sidebar entry
//     for a session that does not exist on the engine side. That is the
//     fake-success failure mode #110 exists to prevent, in the exact
//     shape the gate exists to prevent: a 200 with an entry and no
//     session. The 501 machinery in `errors.js` is therefore in use by
//     this endpoint, and the router's existing central mapping answers
//     it — no route has to remember to catch it.
//
//   - #71 GATES SOFT, and the reason is that hard-gating it would BE
//     the decision a human has not made yet. The plan (§3a, the
//     activate row) records the situation exactly: one ACP client
//     tracks a single active session, so "activate another" is how the
//     client is re-pointed; the in-process host has NO single-active-
//     session concept at all; and the endpoint's fate is therefore an
//     either/or — "语义塌缩（cs 切换 + resume）, 或 501". Those are two
//     different products. Choosing the 501 branch is a real answer to
//     that question and this batch is not entitled to give it: it would
//     be given silently, by a capability table, with no changelog and
//     no frontend work. So `checkSessionActivateCapability` REPORTS,
//     the route keeps the pre-M3 shape and status mapping byte for
//     byte, and the decision itself is KNOWN DEBT 1 with both branches
//     costed.
//
// One family, two gate functions, rather than two modules. B2 split
// `session-tree-reads.js` from `session-export.js` because those two
// endpoints declare DIFFERENT capabilities and their gate MECHANICS
// differ (throw vs report) for unrelated reasons. Here the mechanics
// are the same two functions every other family already uses, both
// endpoints share one capability, and they share a store, a client
// state and a route module. Splitting would duplicate the transport
// table, the resolver and the two status mappers to keep a distinction
// that is one `enforcement` field wide — which is exactly the shape
// B5's mixed `session-writes.js` table already carries, for the same
// reason.
//
// What this file deliberately does NOT do:
//
//   - It does not decide what #71 means under a provider without
//     single-active-session semantics. See KNOWN DEBT 1.
//   - It does not own the session store. `lib/sessions.js` keeps the
//     load/save and the overlay rule; this file orders the calls.
//   - It does not own the status codes. The `code` → HTTP mapping
//     happens here, but the number is returned as `statusHint` and the
//     route writes it, so the engine layer never learns what a status
//     is.
//   - It does not build a host. There is no host on this path at all.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It statically imports nothing
// heavier than `engine/index.js` (a pure declaration module) and nothing
// else; `lib/mcode-rpc.js`, `lib/sessions.js` and `lib/config.js` are
// reached through `await import()` inside the data-plane functions. The
// pure derivations below take their dependencies as arguments for the
// same reason twice over: they stay testable without a module
// registry, and the boot path never sees a session-store import.
//
// Provider selection is M4's job, same as B1 through B6:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// today only `runtime` has one, so under the default `acp` transport the
// gates report `gate: "unregistered-transport"` and both endpoints
// proceed — which is correct, because the pre-M4 behaviour under `acp`
// is the only behaviour these endpoints have ever had.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`, `session-tree-reads.js`,
 * `usage-reads.js`, `account-reads.js`, `session-writes.js`,
 * `session-switch.js` and `interrupt.js`, which this mirrors rather
 * than merges: seven families with separate contracts, and a shared
 * table would force this one to inherit another's policy.
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

// ---------------------------------------------------------------------------
// The declaration, and the two gate policies that go with it
// ---------------------------------------------------------------------------

/**
 * The declaration this family's engine-facing half needs.
 *
 * `sessionCrud` is the honest mapping: loading a session and activating
 * a session are both "point an engine at a session", which is what
 * B1's `getSession` read, B5's `deleteSession` write and B6's soft
 * `getSession` all name. Both providers declare it `full` today, which
 * is precisely why #70's hard gate costs nothing on the current
 * two-transport matrix — a hard gate is only observable once some
 * provider declares the sub-item absent, and that is M4's problem to
 * answer with evidence rather than this batch's to pre-empt.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "hard"|"soft"}>>}
 */
export const SESSION_LOAD_ENDPOINTS = Object.freeze({
  "POST /api/protocol/load-session": Object.freeze({
    capability: "sessionCrud",
    subItem: "loadSession",
    enforcement: "hard",
  }),
  "POST /api/protocol/activate-session": Object.freeze({
    capability: "sessionCrud",
    subItem: "activateSession",
    enforcement: "soft",
  }),
});

/**
 * Resolve the provider that answers the load/activate family on
 * `transport`, or `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionLoadProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * HARD gate — #70 only. Throws `EngineCapabilityNotSupportedError` for
 * a declared `none` (or for a `partial` naming this sub-item), which
 * the router maps to 501 with `engineCapabilityHttpResponse`'s payload.
 *
 * Unlike its soft sibling below, an unknown endpoint key is ALSO a
 * plain Error: the hard path is the one whose 501 body a client can
 * see, and a typo in webui's own key must never be reported to a user
 * as an engine limitation.
 *
 * @param {string} endpoint  A key of SESSION_LOAD_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string, subItem: string, enforcement: "hard"}}
 */
export function assertSessionLoadCapability(endpoint, transport) {
  const need = SESSION_LOAD_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `assertSessionLoadCapability: "${endpoint}" is not part of the load/activate family ` +
        `(known: ${Object.keys(SESSION_LOAD_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_load_endpoint";
    throw err;
  }
  const provider = resolveSessionLoadProvider(transport);
  if (!provider) {
    return {
      endpoint,
      gate: "unregistered-transport",
      provider: null,
      capability: need.capability,
      subItem: need.subItem,
      enforcement: need.enforcement,
    };
  }
  const entry = provider.capabilities ? provider.capabilities[need.capability] : undefined;
  if (entry && entry.level === "full") {
    return {
      endpoint,
      gate: "checked",
      provider: provider.id,
      capability: need.capability,
      subItem: need.subItem,
      enforcement: need.enforcement,
    };
  }
  // Throws for `partial` with this sub-item missing, and for `none` /
  // no entry at all.
  assertEngineCapability(provider.capabilities, need.capability, provider.id, need.subItem);
  return {
    endpoint,
    gate: "partial",
    provider: provider.id,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
}

/**
 * SOFT gate — #71 only. Reports and never throws; see the module header
 * for why hard-gating the activate endpoint would be taking the
 * decision this batch is required to leave open.
 *
 * @param {string} endpoint  A key of SESSION_LOAD_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string, subItem: string, enforcement: "soft"}}
 */
export function checkSessionActivateCapability(endpoint, transport) {
  const need = SESSION_LOAD_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkSessionActivateCapability: "${endpoint}" is not part of the load/activate family ` +
        `(known: ${Object.keys(SESSION_LOAD_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_load_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveSessionLoadProvider(transport);
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
  // `none`, or no entry at all — report it. The caller keeps the
  // pre-M3 shape; the decision is KNOWN DEBT 1.
  return { ...descriptor, gate: "capability-absent" };
}

// ---------------------------------------------------------------------------
// Pure derivations. Exported and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * #70's `code` → HTTP status, and the `no_client` case is the only one
 * that is not a straight default.
 *
 * The map is deliberately NOT the one #67/`set-mode` uses, and the
 * difference is load-bearing: `set-mode` answers 501 for
 * `code === "unsupported"`, #70 answers 500. The existing suite pins
 * that asymmetry ("handleLoadSession has DIFFERENT mapping than
 * setMode"), and unifying them would be a behaviour change to two
 * endpoints at once, not a migration step.
 *
 * Extracted as a pure function rather than left inline so the whole
 * table can be asserted on its inputs, including the rows no fixture
 * reaches.
 *
 * @param {string|undefined} code  The RPC wrapper's `code`.
 * @returns {number}
 */
export function loadFailureStatus(code) {
  if (code === "no_client") return 503;
  if (code && /not.found|invalid/i.test(code)) return 404;
  return 500;
}

/**
 * #70's wire `code`, which is not always the code it received.
 *
 * The engine answers "Resource not found" as `-32004` /
 * `resource_not_found`, neither of which reads as a session problem to
 * a frontend. The rewrite to `session_not_found` is the endpoint's
 * documented contract and is asserted as a value, not as a regex: an
 * undefined code stays undefined so `JSON.stringify` drops the key
 * exactly as it did before this batch.
 *
 * @param {string|undefined} code  The RPC wrapper's `code`.
 * @returns {string|undefined}
 */
export function loadFailureWireCode(code) {
  if (code && /not.found|resource/i.test(code)) return "session_not_found";
  return code;
}

/**
 * #71's `code` → HTTP status. Same shape as #70's with one extra row:
 * `unsupported` answers 501 here, matching `set-mode` and
 * `set-config-option`. That is the pre-M3 mapping and it is preserved
 * byte for byte — see the module header for why a hard CAPABILITY gate
 * (which would answer a different 501, with a different body) is not
 * the same thing as this one and must not quietly replace it.
 *
 * @param {string|undefined} code  The RPC wrapper's `code`.
 * @returns {number}
 */
export function activateFailureStatus(code) {
  if (code === "unsupported") return 501;
  if (code === "no_client") return 503;
  if (code && /not.found|invalid/i.test(code)) return 404;
  return 500;
}

// ---------------------------------------------------------------------------
// Data plane
// ---------------------------------------------------------------------------

/**
 * #70 — load a session on the engine, and optionally wrap it for the
 * sidebar.
 *
 * The order below IS the endpoint's contract:
 *
 *   1. HARD CAPABILITY CHECK. Throws for a provider that declares the
 *      capability absent; the router answers 501. Under the default
 *      `acp` transport no provider is registered and the check reports
 *      `unregistered-transport`, which is the pre-M3 behaviour.
 *   2. ENGINE LOAD. `sessionId` and the resolved `cwd` go to the engine.
 *      The cwd precedence — explicit argument, else the client's current
 *      workspace, else `""` — is the caller's, and it is kept verbatim.
 *   3. STATUS + WIRE CODE. `loadFailureStatus` / `loadFailureWireCode`.
 *      Nothing below this point runs on a failure, so a failed load can
 *      never leave a sidebar entry behind.
 *   4. SIDEBAR ENTRY, only when the caller asked for one AND the engine
 *      answered. Idempotent on `mcodeSessionId`.
 *
 * The response body is built HERE and never re-assembled in the route.
 * `webuiEntry` is `null` — not omitted, not `{}` — when no entry was
 * requested, because that literal is in the pinned wire shape.
 *
 * @param {object} options
 * @param {string} options.sessionId  Already validated non-empty.
 * @param {string} [options.cwd]      Explicit cwd; falls back to the
 *        client's workspace.
 * @param {boolean} [options.createWebuiEntry]
 * @param {object} [options.cs]       The requesting client's state; read
 *        for its workspace only, and never mutated.
 * @param {string} [options.transport]
 * @param {() => string} [options.newId]  Injection seam for the entry's
 *        id. Defaults to `crypto.randomUUID`; the suite injects a
 *        counter so the created record is assertable.
 * @returns {Promise<{payload: object, statusHint: number, gate: object, transport: string}>}
 */
export async function loadEngineSession(options = {}) {
  const endpoint = options.endpoint || "POST /api/protocol/load-session";
  const [rpc, sessions, config] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/sessions.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertSessionLoadCapability(endpoint, transport);
  const cs = options.cs;
  const sessionId = options.sessionId;
  const r = await rpc.loadSession(sessionId, options.cwd || (cs && cs.workspace && cs.workspace.dir) || "");
  if (!r.ok) {
    return {
      payload: { ok: false, error: r.error, code: loadFailureWireCode(r.code) },
      statusHint: loadFailureStatus(r.code),
      gate,
      transport,
    };
  }
  let webuiEntry = null;
  if (options.createWebuiEntry && cs) {
    // 在 webui session db 创建 entry, 让 sidebar 1:1 看到这个 mcode session
    const all = sessions.loadSessions();
    const existing = all.find((s) => s.mcodeSessionId === sessionId);
    if (existing) {
      webuiEntry = existing;
    } else {
      const newId = options.newId || (await import("node:crypto")).randomUUID;
      webuiEntry = {
        id: newId(),
        mcodeSessionId: sessionId,
        title: "Mcode session",
        workspace: options.cwd || (cs.workspace && cs.workspace.dir) || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        chat: [],
      };
      all.unshift(webuiEntry);
      sessions.saveSessions(all);
    }
    // 不自动切到 webui 当前 session (调用方决定)
  }
  return {
    payload: { ok: true, sessionId, webuiEntry },
    statusHint: 200,
    gate,
    transport,
  };
}

/**
 * #71 — point the engine AND webui's client state at a session.
 *
 * The order below IS the endpoint's contract:
 *
 *   1. SOFT CAPABILITY CHECK. Reports only; see the module header.
 *   2. ENGINE ACTIVATE.
 *   3. STATUS. `activateFailureStatus`.
 *   4. `cs.mcodeSessionId = sessionId`, THEN `resetContext(cs)` — the
 *      order is the endpoint's meaning, and reversing it leaves the
 *      context panel describing the session the user just left.
 *
 * The response body is built here, next to the mutation, and the state
 * push stays in the route because it is a transport concern and must
 * not fire when the activate failed.
 *
 * @param {object} options
 * @param {string} options.sessionId  Already validated non-empty.
 * @param {object} [options.cs]  Mutated on success only.
 * @param {string} [options.transport]
 * @returns {Promise<{payload: object, statusHint: number, gate: object, transport: string}>}
 */
export async function activateEngineSession(options = {}) {
  const endpoint = options.endpoint || "POST /api/protocol/activate-session";
  const [rpc, sessions, config] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/sessions.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = checkSessionActivateCapability(endpoint, transport);
  const sessionId = options.sessionId;
  const r = await rpc.activateSession(sessionId);
  if (!r.ok) {
    return {
      payload: { ok: false, error: r.error, code: r.code },
      statusHint: activateFailureStatus(r.code),
      gate,
      transport,
    };
  }
  const cs = options.cs;
  if (cs) {
    cs.mcodeSessionId = sessionId;
    sessions.resetContext(cs);
  }
  return {
    payload: { ok: true, activeSessionId: sessionId, data: r.data },
    statusHint: 200,
    gate,
    transport,
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// Recorded here rather than fixed, because each item is a decision that
// belongs to a human and not to a refactor:
//
//   1. #71's SEMANTIC COLLAPSE IS UNDECIDED, and this batch's only move
//      was to NOT decide it. The situation, from the plan (§3a): one
//      ACP client tracks a single active session, so `session/activate`
//      is how the client is re-pointed at another one; the in-process
//      host has no single-active-session concept at all; and the plan
//      gives the endpoint's fate as an either/or — "语义塌缩（cs 切换 +
//      resume）, 或 501". Both branches, with what each costs:
//
//      a. COLLAPSE INTO "switch + resume". #70 already loads an
//         arbitrary session onto the engine, and B6's #3 already
//         rebinds webui's client state onto an arbitrary session. So
//         the collapsed endpoint is very nearly the COMPOSITION of the
//         two endpoints this batch already has behind the facade. The
//         cost is not the implementation, it is the RESPONSE SHAPE:
//         today's body is `{ok, activeSessionId, data}` where `data` is
//         the engine's raw `session/activate` reply, and a collapsed
//         endpoint has no such reply to forward. It would have to grow
//         the switch payload (B6's `{ok, session:{…}}`, a much larger
//         and byte-pinned object) or invent a new one — and either way
//         the frontend, the docs and the two-language documentation all
//         change. It also changes the endpoint's MEANING: "activate"
//         today mutates nothing in webui's state beyond the two lines
//         in step 4, while "switch" re-roots the workspace, the chat
//         buffer and the context counters. A frontend that keeps
//         calling it as activate would suddenly get a workspace change.
//      b. 501 WHEN NO PROVIDER CAN ACTIVATE. Cheap to build — the
//         hard-gate machinery already exists in this very file for
//         #70, and the router already maps the error. The costs are
//         elsewhere: it is a user-visible behaviour change on a route
//         the frontend calls today, it needs the §4.2 UI degradation
//         (hide or disable the entry point, not an error toast), and
//         it would fire for EVERY provider that has no single-active-
//         session concept — which, per the plan, is the in-process host
//         the default runtime transport is built on. In other words the
//         501 branch most likely lands on the transport with the most
//         users, for an endpoint that works today.
//      The tie-breaker is product knowledge this batch does not have:
//      who calls #71, and what they expect to happen to the sidebar,
//      the chat buffer and the workspace when it returns 200. That is
//      the question to ask; the answer decides the branch. Until then
//      the endpoint keeps its pre-M3 shape and status mapping, and
//      `checkSessionActivateCapability` keeps reporting.
//
//   2. #70's SIDEBAR ENTRY IS STILL A WEBUI-SIDE WRITE THE ENGINE
//      KNOWS NOTHING ABOUT. The same asymmetry B6 recorded for the
//      switch's first-touch overlay: webui's wrapper list and the
//      engine's own session list are two different questions that
//      happen to agree. Pre-existing behaviour, unchanged here, and
//      closing it means deciding who owns session identity.
//
//   3. #70's 501 IS THE GATE'S 501, NOT THE ROUTE'S. `loadSession`
//      answers 500 for `code === "unsupported"`, while a provider that
//      declares `sessionCrud.loadSession` absent answers 501 with
//      `engineCapabilityHttpResponse`'s body. Two different 501s and
//      two different bodies can therefore reach this one route, and
//      only the second has ever existed. The router's central mapping
//      is what keeps them from being confused for each other, and a
//      frontend that special-cases the 501 will see the engine-gate
//      body first and the RPC-`unsupported` 500 never. Worth
//      confirming against the frontend before M4 registers a provider
//      that can trip it.
//
//   4. #70's "Resource not found" REWRITE ONLY MATCHES THE STRING FORM.
//      The route comment names both shapes the engine can answer with —
//      `-32004` and `resource_not_found` — but the rewrite regex
//      (`/not.found|resource/i`) only matches the second, so a numeric
//      JSON-RPC code reaches the frontend verbatim behind a 500.
//      `lib/mcode-rpc.js` puts `e.data.code` into `code`, and that is
//      the string form in practice, which is why the gap has never been
//      observed. Both behaviours are pinned as-is: widening the regex
//      would change a wire shape, and the wider question — whether a
//      JSON-RPC numeric code should be translated here at all, or
//      normalised once in `mcode-rpc.js` for every caller — is a change
//      to the RPC wrapper's contract, not to this endpoint.
