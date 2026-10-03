// webui/server/engine/session-context-actions.js
//
// Placeholder batch PB-1: the four session right-click actions
// (会话右键菜单四项).
//
//   归档   POST /api/sessions/:id/archive         → archiveSession
//   置顶   POST /api/sessions/:id/pin             → pinService.pinSession
//   复制   GET  /api/sessions/:id/fork-options    → getSessionForkOptions
//   复制   POST /api/sessions/:id/fork            → forkSession
//
// What this batch unlocks, and what it deliberately does not.
//
//   UNLOCKED (3): 归档 / 置顶 / 复制为新会话. Each of the three had a
//   complete engine method behind it the whole time
//   (local-runtime-v2/src/local/cli-service.ts `archiveSession` :183,
//   `getSessionForkOptions` :214, `forkSession` :224, plus
//   `service/pin/service.ts#pinSession` :61) and no HTTP window.
//   session-tree.tsx rendered them as permanently greyed rows with the
//   comment "no … contract yet" — which was true about the ROUTE and
//   false about the CAPABILITY. That distinction is the whole batch.
//
//   STILL GREY (2), and the reason each one is still grey is recorded at
//   its own `disabled` site rather than left to be re-derived:
//
//   - 复制到新工作树 (`fork-worktree`). The engine's fork request HAS the
//     flag — `ForkSessionInput.createIsolatedWorktree: boolean` — and
//     `getSessionForkOptions` already reports `worktreeVisible` /
//     `worktreeEligible` / `worktreeUnavailableReason`. What is missing
//     is a REFERENCE: no desktop screenshot of this menu exists in
//     design-ref/, so the shape of the worktree variant (does it prompt?
//     which branch? what does it do to the source session?) is unknown.
//     Inventing one would be self-authored UI. See `session-tree.tsx`
//     and KNOWN DEBT 1.
//
//   - 项目右键「归档对话」(`session-tree.tsx:575`). The semantics are
//     BULK archive of every session under a project. v2 declares
//     `archiveSession({id, archived})` — a single session — and no
//     project-level equivalent. A batch endpoint would have to fan out
//     N single-session writes, which is a product decision (partial
//     failure semantics, authorization once or N times) and not a
//     window. See KNOWN DEBT 2.
//
// The gate, and why it is not the same gate as the write family's.
//
// Three of the four endpoints (`archive`, `fork-options`, `fork`) read
// and write through `host.cliService`, the surface
// `local-runtime-v2.capabilities.js` declares `sessionCrud: full` over.
// Those get a DECLARATION gate, exactly as
// `engine/session-writes.js` does: `sessionCrud` plus the exact sub-item
// name, so a provider that drops `archiveSession` goes 501 rather than
// answering `{ok:true}` and changing nothing.
//
// `pin` is the odd one out and the oddness is load-bearing. `pinSession`
// is NOT on `cliService` — it is on `host.services.pinService`, the V2
// owner graph that PB-8 opened a window onto. Two consequences:
//
//   1. There is no capability key for it. `ENGINE_CAPABILITY_KEYS` is a
//      fixed 14-key audited matrix
//      (`server/engine/capabilities.js:44`), and adding a 15th key for
//      this batch would restate three provider declarations and the
//      snapshot audit for one method. The honest answer for THIS batch
//      is the presence gate PB-8's own header prescribes for exactly
//      this situation: "Consumers that need cron must gate on its
//      presence rather than assume it."
//
//   2. The presence gate is the three-state `getHostServices()` answer,
//      and all three states are distinct failures with distinct codes:
//        null      → no runtime booted          → 503 engine_host_unavailable
//        undefined → a host with no owner graph → 501 engine_services_unavailable
//        object    → but no `pinService` member → 501 pin_service_unavailable
//      None of them may fall through to a success payload. A pin that
//      "succeeded" without writing anything is the fake-success shape
//      #110 fixed and this repository refuses to reintroduce.
//
// Pin and the tree read.
//
// A pin that cannot be seen is not a pin. `lib/session-tree.js` sorts
// the sidebar by `updated_at_ms` and has no column for pin state, so
// `readEnginePinnedSessionOrder()` below reads the engine's own order
// and `GET /api/session-tree` overlays it. That read DEGRADES rather
// than fails: a host that cannot answer leaves the tree exactly as it
// was, because a sidebar that will not render because the pin service
// is absent is a worse failure than a sidebar whose pins are not
// currently shown. That asymmetry is deliberate and is the only soft
// gate in this file; the four endpoints themselves never degrade.
//
// Boot-path discipline, unchanged from `host-services.js`: nothing heavy
// is imported statically. The engine facade and the tree cache are
// reached through `await import()` inside the functions.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

/**
 * The declaration each endpoint of this family needs.
 *
 * `gate` names HOW the row is enforced, and it takes three values
 * because the family genuinely has three shapes:
 *
 *   - `"capability"` — the standard `capability` + `subItem`
 *     declaration, enforced through `assertEngineCapability`. A provider
 *     that lacks the sub-item throws `EngineCapabilityNotSupportedError`
 *     and `app.js#invokeHandler` turns it into 501.
 *   - `"host-services"` — the PB-8 presence gate. `capability` is
 *     `null` because no key covers it; the row is enforced by the
 *     three-state member read below, which throws for `undefined` and
 *     returns a typed failure for `null`.
 *   - `"none"` — declared for uniformity so that adding a row is a
 *     table edit rather than a change to this module's shape. No row
 *     uses it today; the field exists because a `null` hole in the
 *     middle of a uniform table is the kind of shape a later edit
 *     mistakes for "not filled in yet" (`session-writes.js` records the
 *     same reasoning for its own `capability: null` rename row).
 *
 * `member` is the host path the call is made through, so the resolution
 * helper is data-driven and a fifth row needs no new branch.
 *
 * @typedef {{gate: "capability"|"host-services"|"none", capability: string|null, subItem: string|null, member: "cliService"|"services.pinService", method: string}} SessionContextActionDeclaration
 * @type {Readonly<Record<string, SessionContextActionDeclaration>>}
 */
export const SESSION_CONTEXT_ACTION_ENDPOINTS = Object.freeze({
  "POST /api/sessions/:id/archive": Object.freeze({
    gate: "capability",
    capability: "sessionCrud",
    subItem: "archiveSession",
    member: "cliService",
    method: "archiveSession",
  }),
  "GET /api/sessions/:id/fork-options": Object.freeze({
    gate: "capability",
    capability: "sessionCrud",
    subItem: "getSessionForkOptions",
    member: "cliService",
    method: "getSessionForkOptions",
  }),
  "POST /api/sessions/:id/fork": Object.freeze({
    gate: "capability",
    capability: "sessionCrud",
    subItem: "forkSession",
    member: "cliService",
    method: "forkSession",
  }),
  "POST /api/sessions/:id/pin": Object.freeze({
    gate: "host-services",
    capability: null,
    subItem: null,
    member: "services.pinService",
    method: "pinSession",
  }),
});

/**
 * The capability key the `cliService` rows are declared under, for the
 * degradation summary the frontend reads. A pure re-export of the one
 * string, so a future key migration is one edit.
 */
export const SESSION_CONTEXT_ACTION_CAPABILITY = "sessionCrud";

/** The endpoint keys of this family, in `OWNED_ROUTES` order. */
export const SESSION_CONTEXT_ACTION_ROUTES = Object.freeze(
  Object.keys(SESSION_CONTEXT_ACTION_ENDPOINTS),
);

function providerByTransport() {
  // Built per call, never frozen at module scope: `engine/index.js`
  // re-exports this module, so a module-level table would read
  // `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
  // temporal dead zone on a cold `import("./engine/index.js")`. Same
  // reason, same wording as `session-writes.js#providerByTransport`.
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * Resolve the provider that answers session context actions on
 * `transport`, or `null` when none is registered yet.
 *
 * `null` means "no provider claims this transport", which is NOT the
 * same answer as "the provider lacks the capability" — the first lets
 * the call proceed to the in-process host (the M4-3a shape: under
 * `acp` there is no registered provider, and the work still runs on the
 * process-local `local-runtime-v2` host reached through
 * `getEngineCatalogueHost()`), the second must 501. Collapsing the two
 * would delete a working endpoint on a statement about nothing.
 *
 * @param {string} transport
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionContextActionProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Check one endpoint of this family against the active provider's
 * declaration. Throws `EngineCapabilityNotSupportedError` (→ 501) when
 * a `"capability"` row's capability or exact sub-item is absent.
 *
 * A `"host-services"` row returns without consulting the provider at
 * all: its enforcement is the member read, which happens at dispatch
 * time against the live host and not against a static declaration.
 *
 * @param {string} endpoint A key of `SESSION_CONTEXT_ACTION_ENDPOINTS`.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: string}}
 */
export function assertSessionContextActionCapability(endpoint, transport) {
  const need = SESSION_CONTEXT_ACTION_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation — a plain Error, so the
    // HTTP layer never answers 501 for a typo in webui's own code.
    const err = new Error(
      `assertSessionContextActionCapability: "${endpoint}" is not part of the session context action family ` +
        `(known: ${SESSION_CONTEXT_ACTION_ROUTES.join(", ")})`,
    );
    err.code = "unknown_session_context_action_endpoint";
    throw err;
  }
  const provider = resolveSessionContextActionProvider(transport);
  const base = {
    endpoint,
    provider: provider ? provider.id : null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.gate,
  };
  if (need.gate === "host-services" || need.gate === "none") {
    return { ...base, gate: need.gate };
  }
  if (!provider) {
    return { ...base, gate: "unregistered-transport" };
  }
  assertEngineCapability(provider.capabilities, need.capability, provider.id, need.subItem);
  return { ...base, gate: "checked" };
}

// ---------------------------------------------------------------------------
// Member resolution — the three-state rule, once
// ---------------------------------------------------------------------------

/**
 * A resolved engine member, or a typed failure. Exactly one of the two
 * shapes is returned; there is no third answer in which the member is
 * absent and the call proceeds.
 *
 * @typedef {{ok: true, member: Function, host: object, window: object}} ResolvedContextActionMember
 * @typedef {{ok: false, code: "engine_host_unavailable"|"engine_services_unavailable"|"engine_member_unavailable", status: 503|501, error: string}} ResolvedContextActionFailure
 */

/**
 * Read one member off a booted catalogue host, honouring the three-state
 * `getHostServices()` contract from PB-8 without collapsing any of its
 * three answers.
 *
 * Why the distinction survives here. `getHostServices()` returns
 * `null` for "no runtime booted" and `undefined` for "a host that
 * carries no owner graph"; the two have different HTTP meanings
 * (503 vs 501) and, more importantly, different OPERATOR meanings: the
 * first is a boot failure to look at, the second is a transport that
 * simply has no V2 slice. A caller that mapped both to "unavailable"
 * would have made the first look like the second.
 *
 * The `cliService` member does not go through `getHostServices()` at
 * all — it is on the host itself — but it is resolved through the same
 * helper so both halves of the family produce the same failure shape and
 * the route has exactly one error branch.
 *
 * @param {object} options
 * @param {string} options.endpoint   Endpoint key, for the error text.
 * @param {string} options.member     `"cliService"` or `"services.pinService"`.
 * @param {string} options.method     Method name, for the failure text.
 * @param {object} [options.deps]     Injection seams; see each function.
 * @returns {Promise<ResolvedContextActionMember|ResolvedContextActionFailure>}
 */
async function resolveContextActionMember(options) {
  const { endpoint, member, method, deps = {} } = options;
  const getHost = deps.getHost || (await import("./host.js")).getEngineCatalogueHost;
  let host;
  try {
    host = await getHost();
  } catch (e) {
    // A throwing host getter propagates through `getEngineCatalogueHost`
    // unchanged everywhere else in the facade; here it is caught so the
    // route can answer 503 with a body instead of an unhandled rejection.
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: e && e.message ? e.message : String(e),
    };
  }
  if (!host) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${endpoint}: the engine catalogue host is not available`,
    };
  }

  let window = host;
  if (member === "cliService") {
    if (typeof host.cliService?.[method] !== "function") {
      return {
        ok: false,
        code: "engine_member_unavailable",
        status: 501,
        error: `${endpoint}: host.cliService.${method} is not a function`,
      };
    }
    return { ok: true, member: host.cliService[method].bind(host.cliService), host, window };
  }

  // `services.*` — the PB-8 window. Read as-is, never `??`-folded, so
  // "no owner graph" and "owner graph without this member" stay apart.
  window = host.services;
  if (window === null) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${endpoint}: the engine catalogue host is not available`,
    };
  }
  if (window === undefined) {
    return {
      ok: false,
      code: "engine_services_unavailable",
      status: 501,
      error: `${endpoint}: this engine host carries no services owner graph`,
    };
  }
  // The dotted path is rooted at the HOST, not at the window: `member` is
  // written the way it reads on the host (`services.pinService`), so it is
  // walked from `host` after the window's own three states have been
  // checked. Walking it from `window` would look for `window.services` —
  // a path that does not exist — and answer 501 for a member that is
  // right there.
  const resolved = member.split(".").reduce((node, key) => (node == null ? undefined : node[key]), host);
  if (typeof resolved?.[method] !== "function") {
    return {
      ok: false,
      code: "engine_member_unavailable",
      status: 501,
      error: `${endpoint}: host.${member}.${method} is not a function`,
    };
  }
  return { ok: true, member: resolved[method].bind(resolved), host, window };
}

/**
 * A typed failure rendered as this module's failure payload. The route
 * turns it into a status; this module never decides one on its own,
 * because `status` is the HTTP layer's concern and `code` is the
 * contract.
 *
 * @param {ResolvedContextActionFailure} failure
 * @returns {{ok: false, code: string, error: string, status: number}}
 */
function failurePayload(failure) {
  return { ok: false, code: failure.code, error: failure.error, status: failure.status };
}

// ---------------------------------------------------------------------------
// Pure derivations — exported and tested on their INPUTS
// ---------------------------------------------------------------------------

/**
 * Whether an archive request is a well-formed `POST
 * /api/sessions/:id/archive` body.
 *
 * `archived` is BOOLEAN-COERCED rather than type-checked, and the reason
 * matters: `lifecycle-application.ts#archiveSession` reads
 * `req.archived !== false`, so anything that is not literally `false`
 * archives. A validator that demanded `typeof === "boolean"` would
 * 400 a body the engine would have accepted, and a validator that
 * passed `undefined` straight through would archive a session whose
 * caller meant to unarchive. Defaulting to `true` and comparing against
 * `false` reproduces the engine's own rule exactly, so the two can
 * never disagree about the same request.
 *
 * @param {unknown} body
 * @returns {{ok: true, archived: boolean}|{ok: false, error: string}}
 */
export function parseArchiveRequestBody(body) {
  const raw = body && typeof body === "object" ? body.archived : undefined;
  if (raw === undefined) return { ok: true, archived: true };
  if (raw === null) return { ok: true, archived: true };
  return { ok: true, archived: raw !== false };
}

/**
 * Whether a pin request is a well-formed `POST
 * /api/sessions/:id/pin` body.
 *
 * Unlike archive, `PinService#pinSession(sessionId, pinned, …)` takes
 * the flag as a required positional and branches on it, so this one IS
 * type-checked: a body of `{}` means "the caller did not say", and the
 * menu item is a TOGGLE, so guessing either way would move the row in
 * the direction the user did not ask for. `parsePinRequestBody` exists
 * as a named predicate rather than an inline `body.pinned === true`
 * so the "unpin" direction is a tested case and not an accident.
 *
 * @param {unknown} body
 * @returns {{ok: true, pinned: boolean}|{ok: false, error: string}}
 */
export function parsePinRequestBody(body) {
  const raw = body && typeof body === "object" ? body.pinned : undefined;
  if (typeof raw !== "boolean") {
    return { ok: false, error: "pinned must be a boolean" };
  }
  return { ok: true, pinned: raw };
}

/**
 * The `ForkSessionInput` this endpoint sends, as a PURE function of the
 * validated request fields.
 *
 * Three fields are FORCED rather than forwarded, and each forcing is a
 * decision this batch made:
 *
 *   - `useSuggestedTitle: true` — the fork's title comes from the
 *     engine's own suggestion (`getSessionForkOptions` returns
 *     `suggestedTitle` and `nextForkOrdinal`). Letting the client
 *     override it is a second title contract; the menu item is
 *     "duplicate", and a duplicate keeps the source's name shape.
 *     The suggestion is still SHOWN in the preview dialog — the user
 *     sees exactly the title that will be used.
 *   - `createIsolatedWorktree: false` — the worktree variant is the
 *     honest placeholder described in this file's header. The field
 *     exists on the protocol and is deliberately left `false` here, so
 *     the "duplicate as new session" action can never accidentally
 *     create a worktree the UI never asked the user about.
 *   - `clientRequestId` — the protocol requires it, and it is the
 *     engine's fork-deduplication key. It is minted per REQUEST, so a
 *     retried POST of the same user intent creates a second fork while
 *     a duplicate delivery of one POST does not. The route mints it;
 *     this function takes it as a parameter so the value is visible at
 *     the call site rather than buried in a `randomUUID()` here.
 *
 * `assistantMessageId` is the fork POINT and is forwarded as given: an
 * absent value forks the whole conversation, which is what the menu
 * item means when the user has not picked a message.
 *
 * @param {object} fields
 * @param {string} fields.id                   Source session id.
 * @param {string} fields.clientRequestId      Per-request fork key.
 * @param {string} [fields.assistantMessageId] Fork point; absent = whole session.
 * @returns {{id: string, clientRequestId: string, useSuggestedTitle: true, createIsolatedWorktree: false, assistantMessageId?: string}}
 */
export function buildForkRequest(fields) {
  const request = {
    id: fields.id,
    clientRequestId: fields.clientRequestId,
    useSuggestedTitle: true,
    createIsolatedWorktree: false,
  };
  if (fields.assistantMessageId) request.assistantMessageId = fields.assistantMessageId;
  return request;
}

/**
 * The fork-options projection the preview dialog renders, as a PURE
 * narrowing of whatever the engine returned.
 *
 * The narrowing is total on purpose: every field the dialog reads has a
 * defined value for every answer, so a partially-shaped engine response
 * renders an empty option row rather than `undefined` in the DOM. The
 * worktree triple is carried through VERBATIM and unread — this batch
 * gates the worktree variant on absence of a reference, not on the
 * engine's opinion of eligibility, so the fields travel so that PB
 * worktree can consume them without another round trip.
 *
 * @param {object} options The engine's `GetSessionForkOptionsResult`.
 * @returns {{canFork: boolean, unavailableReason: string|null, suggestedTitle: string|null, nextForkOrdinal: number|null, sourceTitle: string|null, worktree: {visible: boolean, eligible: boolean, unavailableReason: string|null}}}
 */
export function projectForkOptions(options) {
  const src = options && typeof options === "object" ? options : {};
  return {
    canFork: src.canFork === true,
    unavailableReason: typeof src.unavailableReason === "string" ? src.unavailableReason : null,
    suggestedTitle: typeof src.suggestedTitle === "string" ? src.suggestedTitle : null,
    nextForkOrdinal: typeof src.nextForkOrdinal === "number" ? src.nextForkOrdinal : null,
    sourceTitle: typeof src.sourceTitle === "string" ? src.sourceTitle : null,
    worktree: {
      visible: src.worktreeVisible === true,
      eligible: src.worktreeEligible === true,
      unavailableReason:
        typeof src.worktreeUnavailableReason === "string" ? src.worktreeUnavailableReason : null,
    },
  };
}

// ---------------------------------------------------------------------------
// The four endpoint bodies
// ---------------------------------------------------------------------------

async function resolveTransport(options) {
  if (options.transport) return options.transport;
  const config = await import("../lib/config.js");
  return config.MCODE_WEBUI_TRANSPORT;
}

/**
 * Drop the sidebar tree cache, and load the modules that own it.
 *
 * Every action in this family changes what `GET /api/session-tree`
 * returns — archive removes a row, fork adds one, pin reorders them —
 * so all four invalidate. The drop is a pure cache clear with no I/O;
 * it is dynamic-imported with the rest so this module keeps the boot
 * path it was written with.
 *
 * @returns {Promise<void>}
 */
async function invalidateTree() {
  const tree = await import("../lib/session-tree.js");
  tree.invalidateSessionTree();
}

/**
 * `POST /api/sessions/:id/archive` — archive OR unarchive one session.
 *
 * The method covers both directions (`req.archived !== false` in
 * `lifecycle-application.ts#archiveSession`), so one endpoint serves
 * both and the direction travels in the body. PB-2's archived-tasks
 * page will call the same endpoint with `archived: false` to restore a
 * row; that is why the flag is honoured rather than pinned to `true`.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {boolean} options.archived
 * @param {string} [options.endpoint]  Endpoint key for the declaration check.
 * @param {string} [options.transport] Transport override.
 * @param {object} [options.deps]      Injection seams for tests.
 * @returns {Promise<{ok: boolean, archived: boolean, code?: string, error?: string, status?: number, payload?: object, gate?: object, transport: string}>}
 */
export async function applyEngineSessionArchive(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/:id/archive";
  const transport = await resolveTransport(options);
  const gate = assertSessionContextActionCapability(endpoint, transport);
  const resolved = await resolveContextActionMember({
    endpoint,
    member: "cliService",
    method: "archiveSession",
    deps: options.deps,
  });
  if (!resolved.ok) {
    return { ok: false, archived: options.archived === true, ...failurePayload(resolved), gate, transport };
  }
  try {
    await resolved.member({ id: options.id, archived: options.archived });
  } catch (e) {
    return {
      ok: false,
      archived: options.archived === true,
      code: "engine_archive_failed",
      status: 502,
      error: e && e.message ? e.message : String(e),
      gate,
      transport,
    };
  }
  // The tree's SQL filter is `WHERE archived = 0`, so an archived row
  // leaves the sidebar on the next read and an unarchived one returns.
  // The cache would otherwise serve the pre-write assembly for 15s.
  await invalidateTree();
  return {
    ok: true,
    archived: options.archived === true,
    payload: { ok: true, id: options.id, archived: options.archived === true },
    gate,
    transport,
  };
}

/**
 * `GET /api/sessions/:id/fork-options` — the preview the duplicate
 * dialog renders.
 *
 * A READ, and the only one in this family. It is not gated on
 * `assertEngineContextActionCapability` for archive's reasons but for a
 * read's own: a provider that cannot fork cannot describe forking, and
 * answering a default-shaped options object would put "canFork: false"
 * on screen as if the engine had said it. The failure is propagated
 * instead, so the dialog reports the same 501 the fork itself would.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string} [options.assistantMessageId]
 * @param {string} [options.transport]
 * @param {object} [options.deps]
 * @returns {Promise<{ok: boolean, options?: object, code?: string, error?: string, status?: number, gate?: object, transport: string}>}
 */
export async function readEngineSessionForkOptions(options = {}) {
  const endpoint = options.endpoint || "GET /api/sessions/:id/fork-options";
  const transport = await resolveTransport(options);
  const gate = assertSessionContextActionCapability(endpoint, transport);
  const resolved = await resolveContextActionMember({
    endpoint,
    member: "cliService",
    method: "getSessionForkOptions",
    deps: options.deps,
  });
  if (!resolved.ok) {
    return { ok: false, ...failurePayload(resolved), gate, transport };
  }
  const request = { id: options.id };
  if (options.assistantMessageId) request.assistantMessageId = options.assistantMessageId;
  try {
    const raw = await resolved.member(request);
    return { ok: true, options: projectForkOptions(raw), gate, transport };
  } catch (e) {
    return {
      ok: false,
      code: "engine_fork_options_failed",
      status: 502,
      error: e && e.message ? e.message : String(e),
      gate,
      transport,
    };
  }
}

/**
 * `POST /api/sessions/:id/fork` — duplicate the conversation as a new
 * session in the SAME workspace (no worktree; see the header).
 *
 * The response carries the created session's id so the frontend can
 * switch to it. A fork that succeeded but reported no id would leave
 * the user looking at a list that grew by one row with no indication
 * of which, so a missing id is reported as a failure of the CALL rather
 * than a success with a null id — the engine's `ForkSessionResult` has
 * `session?` optional, and the optionality is about a session with no
 * view shape, not about a fork that did not happen.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.clientRequestId
 * @param {string} [options.assistantMessageId]
 * @param {string} [options.transport]
 * @param {object} [options.deps]
 * @returns {Promise<{ok: boolean, sessionId?: string, code?: string, error?: string, status?: number, payload?: object, gate?: object, transport: string}>}
 */
export async function applyEngineSessionFork(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/:id/fork";
  const transport = await resolveTransport(options);
  const gate = assertSessionContextActionCapability(endpoint, transport);
  const resolved = await resolveContextActionMember({
    endpoint,
    member: "cliService",
    method: "forkSession",
    deps: options.deps,
  });
  if (!resolved.ok) {
    return { ok: false, ...failurePayload(resolved), gate, transport };
  }
  let raw;
  try {
    raw = await resolved.member(
      buildForkRequest({
        id: options.id,
        clientRequestId: options.clientRequestId,
        assistantMessageId: options.assistantMessageId,
      }),
    );
  } catch (e) {
    return {
      ok: false,
      code: "engine_fork_failed",
      status: 502,
      error: e && e.message ? e.message : String(e),
      gate,
      transport,
    };
  }
  const sessionId = raw && typeof raw === "object" ? raw.session?.id : undefined;
  if (typeof sessionId !== "string" || sessionId === "") {
    // Reached only when the engine's call resolved without a session.
    // Reported, not swallowed: the sidebar refresh below would
    // otherwise show a row appearing with no way to name it.
    return {
      ok: false,
      code: "engine_fork_no_session",
      status: 502,
      error: "the engine reported no forked session",
      gate,
      transport,
    };
  }
  await invalidateTree();
  return {
    ok: true,
    sessionId,
    payload: {
      ok: true,
      id: sessionId,
      sourceId: options.id,
      forkOriginMessageId: raw.forkOriginMessageId ?? null,
    },
    gate,
    transport,
  };
}

/**
 * `POST /api/sessions/:id/pin` — pin or unpin a session.
 *
 * The only endpoint of the family that reads the PB-8 window rather
 * than `host.cliService`, and the one whose absence cases are the most
 * interesting. All three of `getHostServices()`'s states are handled
 * with their own code, and none of them produces a success payload:
 *
 *   null      → 503 engine_host_unavailable     (no runtime booted)
 *   undefined → 501 engine_services_unavailable (host without owner graph)
 *   object    → 501 engine_member_unavailable   (no `pinService` on it)
 *
 * @param {object} options
 * @param {string} options.id
 * @param {boolean} options.pinned
 * @param {string} [options.transport]
 * @param {object} [options.deps]
 * @returns {Promise<{ok: boolean, pinned: boolean, pinnedIds?: string[], code?: string, error?: string, status?: number, payload?: object, gate?: object, transport: string}>}
 */
export async function applyEngineSessionPin(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/:id/pin";
  const transport = await resolveTransport(options);
  const gate = assertSessionContextActionCapability(endpoint, transport);
  const resolved = await resolveContextActionMember({
    endpoint,
    member: "services.pinService",
    method: "pinSession",
    deps: options.deps,
  });
  if (!resolved.ok) {
    return { ok: false, pinned: options.pinned === true, ...failurePayload(resolved), gate, transport };
  }
  let mutation;
  try {
    // No `insertIndex`: the engine appends, and this batch does not offer
    // an ordering control the desktop has no reference for.
    mutation = await resolved.member(options.id, options.pinned === true);
  } catch (e) {
    return {
      ok: false,
      pinned: options.pinned === true,
      code: "engine_pin_failed",
      status: 502,
      error: e && e.message ? e.message : String(e),
      gate,
      transport,
    };
  }
  const pinnedIds = projectPinnedSessionIds(mutation);
  await invalidateTree();
  return {
    ok: true,
    pinned: options.pinned === true,
    pinnedIds,
    payload: { ok: true, id: options.id, pinned: options.pinned === true, pinnedIds },
    gate,
    transport,
  };
}

// ---------------------------------------------------------------------------
// The pin read the sidebar needs — and the one soft gate in this file
// ---------------------------------------------------------------------------

/**
 * The session ids currently pinned, in the engine's own order.
 *
 * A `PinMutation` and a `PinItem[]` are accepted because `pinSession`
 * returns the former and `getOrder()` the latter; both carry the same
 * `items`, and the dialog/tree only ever needs the ids. Non-session
 * refs (agents, projects) are dropped — they are ordered in a different
 * surface that this batch does not render.
 *
 * @param {object} value A `PinMutation` or a `readonly PinItem[]`.
 * @returns {string[]}
 */
export function projectPinnedSessionIds(value) {
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? value.items : null;
  if (!Array.isArray(items)) return [];
  const ids = [];
  for (const item of items) {
    const ref = item && typeof item === "object" ? item.ref : null;
    if (ref && ref.type === "session" && typeof ref.id === "string" && ref.id !== "") {
      ids.push(ref.id);
    }
  }
  return ids;
}

/**
 * The pinned session ids for the sidebar overlay, or `[]` when the
 * engine cannot answer.
 *
 * THIS FUNCTION DEGRADES, and it is the only member of this file that
 * does. The reasoning is that the alternative is a sidebar that will
 * not render: `GET /api/session-tree` is the page's primary data
 * source, and a pin service that failed to answer is not a reason to
 * fail the whole tree. An empty answer means "no pins are currently
 * shown", which is a cosmetic loss; a failed tree is a broken page.
 *
 * The contrast with the four endpoints above is the point: those
 * MUTATE, and a mutation that cannot confirm its write must not claim
 * success. This one only reads an ordering, and an ordering has no
 * truth to falsify — the worst a wrong answer can do is show a row in
 * the wrong place, and the next successful read corrects it.
 *
 * IT USES THE NON-BOOTING HOST GETTER, and that is not a detail. The
 * ordinary `getEngineCatalogueHost()` boots the runtime on its first
 * call — seconds of construction — so a READ that reached for it would
 * turn the first `GET /api/session-tree` of a fresh process into a
 * runtime boot, and the cost would land on whoever painted the page
 * first while looking like an ordinary slow request. `peekEngineCatalogueHost()`
 * answers `null` when no host is up, which this function reports as a
 * degraded read. The rule it encodes: a write may boot what it needs; a
 * read may only use what is already there.
 *
 * @param {object} [deps]
 * @param {() => Promise<object|null|undefined>} [deps.getHost] Host getter
 *        seam; defaults to the NON-BOOTING peek.
 * @returns {Promise<{pinnedIds: string[], degraded: boolean, reason: string|null}>}
 */
export async function readEnginePinnedSessionOrder(deps = {}) {
  const getHost =
    deps.getHost || (await import("./host.js")).peekEngineCatalogueHost;
  let host;
  try {
    host = await getHost();
  } catch {
    return { pinnedIds: [], degraded: true, reason: "engine_host_unavailable" };
  }
  if (!host) return { pinnedIds: [], degraded: true, reason: "engine_host_unavailable" };
  const services = host.services;
  if (services === undefined) {
    return { pinnedIds: [], degraded: true, reason: "engine_services_unavailable" };
  }
  if (services === null) {
    return { pinnedIds: [], degraded: true, reason: "engine_host_unavailable" };
  }
  const pinService = services.pinService;
  if (typeof pinService?.getOrder !== "function") {
    return { pinnedIds: [], degraded: true, reason: "pin_service_unavailable" };
  }
  try {
    return { pinnedIds: projectPinnedSessionIds(await pinService.getOrder()), degraded: false, reason: null };
  } catch {
    return { pinnedIds: [], degraded: true, reason: "engine_pin_read_failed" };
  }
}

// ---------------------------------------------------------------------------
// The sidebar overlay
// ---------------------------------------------------------------------------

/**
 * Mark the pinned sessions in a `GET /api/session-tree` payload and move
 * them to the top of their directory, in the engine's own pin order.
 *
 * Why this is a PURE overlay and not a change to the SQL. The tree's
 * rows come from `lib/session-tree.js`, which scans
 * `local_runtime_sessions` — a table with no pin column, because the pin
 * state lives in the preference store the `PinService` owns. Making the
 * read aware of pins would mean either joining two stores inside one
 * query or teaching the tree module about a second owner; the overlay
 * keeps `lib/session-tree.js` exactly as it was and puts the second
 * store's contribution at the edge, where a failure can be dropped
 * without taking the tree with it.
 *
 * The ordering is `pinned → not pinned`, and WITHIN each group the
 * existing `updatedAt` order is left untouched. Two rules that are
 * load-bearing in both directions:
 *
 *   - The comparator is STABLE in the sense that matters here: it never
 *     reorders two sessions that are both pinned or both unpinned, so a
 *     tree with no pins at all is byte-identical to the tree before this
 *     batch. A sort that reordered equal keys would make every unpinned
 *     sidebar shuffle on every read.
 *   - Pinned sessions are ordered by the ENGINE's pin order, not by
 *     `updatedAt`. The engine owns that order (`PinService` persists it
 *     under `pinned-items-order`), and a webui-side re-sort would fight
 *     it on the next write. An id the overlay was given but the tree
 *     does not contain is simply absent from the output — the two stores
 *     are read at different instants and this is the window KNOWN DEBT 3
 *     records.
 *
 * `pinned: true` is written onto a session that is pinned and
 * `pinned: false` onto one that is not, so the frontend reads a boolean
 * and never has to know the id set exists. The field is added to EVERY
 * session, including in the untouched unpinned case, because a field
 * that appears only sometimes is a field the client has to guard.
 *
 * @param {object} tree The `getSessionTree` payload, verbatim.
 * @param {string[]} pinnedIds Session ids, in engine pin order.
 * @returns {object} A new payload. The input is not mutated.
 */
export function applyPinnedSessionOverlay(tree, pinnedIds) {
  if (!tree || typeof tree !== "object" || !Array.isArray(tree.projects)) return tree;
  const order = new Map();
  const ids = Array.isArray(pinnedIds) ? pinnedIds : [];
  for (const id of ids) {
    if (typeof id === "string" && id !== "" && !order.has(id)) order.set(id, order.size);
  }
  const rank = (id) => (order.has(id) ? order.get(id) : Number.MAX_SAFE_INTEGER);
  return {
    ...tree,
    projects: tree.projects.map((project) => {
      if (!project || !Array.isArray(project.directories)) return project;
      return {
        ...project,
        directories: project.directories.map((directory) => {
          if (!directory || !Array.isArray(directory.sessions)) return directory;
          return {
            ...directory,
            sessions: directory.sessions
              .map((session) => ({
                ...session,
                pinned: order.has(session?.id),
              }))
              // `rank` already puts every unpinned session after every
              // pinned one, and both groups keep their input order
              // because `Array.prototype.sort` is stable in every engine
              // this project supports (ES2019 guarantees it).
              .sort((a, b) => rank(a?.id) - rank(b?.id)),
          };
        }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// Recorded rather than fixed, because each is a decision that belongs
// to a human and not to a window:
//
//   1. 「复制到新工作树」stays an honest placeholder. The engine side is
//      present and unused: `ForkSessionInput.createIsolatedWorktree`
//      exists, and `getSessionForkOptions` already returns
//      `worktreeVisible` / `worktreeEligible` /
//      `worktreeUnavailableReason` — `projectForkOptions` carries all
//      three through untouched so nothing has to be re-derived. What is
//      absent is a REFERENCE: design-ref/ holds no screenshot of this
//      menu, so the dialog's shape, whether a branch is chosen, and
//      what happens to the source session are all unknown. Per §3.4 of
//      doc/placeholder-batch-plan.md, this batch does not self-author
//      that form.
//
//   2. 项目右键「归档对话」stays an honest placeholder. v2 declares
//      `archiveSession({id, archived})` and nothing project-scoped. A
//      batch endpoint would fan out N single-session writes, and the
//      semantics that fan-out needs — is a partial failure a success?
//      is the user authorized once or N times? does one engine error
//      roll the rest back? — are product decisions that no existing
//      contract answers.
//
//   3. The pin overlay on `GET /api/session-tree` is added in
//      `session-tree-reads.js`, and it reads pin state from the ENGINE
//      while the rest of that read comes from the runtime db. The two
//      stores are not in a transaction, so a pin written between the
//      db scan and the pin read can produce one render that disagrees
//      with itself. The window is 15s and self-correcting; closing it
//      means a single engine query that returns sessions ordered.
//
//   4. `archiveSession` and `forkSession` are declared against
//      `sessionCrud` and therefore inherit that key's meaning on every
//      provider. The `acp` declaration lists `archiveSession` in
//      `missing` (acp.capabilities.js:123) — correct for the PROTOCOL,
//      and the reason this family resolves through the in-process host
//      under that transport is the M4-3a shape, not an oversight. If a
//      future audit finds a provider that declares `sessionCrud: full`
//      without these two methods on its `cliService`, the snapshot test
//      (test/lib/engine/capability-snapshot.test.js:345) is where it
//      goes red.
