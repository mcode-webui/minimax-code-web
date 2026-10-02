// webui/server/engine/session-switch.js
//
// Migration step M3, batch B6: the session SWITCH endpoint (会话切换) —
//
//   #3  POST /api/sessions/switch — switch the active session by webui
//                                      uuid or `mvs_…` sid
//
// What this file is for. #3 is the busiest single endpoint in this
// migration and the one whose failure modes are all user-visible at once:
// a wrong answer here loses the conversation on screen, re-roots the file
// tree on the wrong project, or resurrects the "extra untitled entry"
// sidebar confusion. Before M3 all of it lived in the route — resolve,
// overlay creation, title lookup, transcript backfill, workspace
// containment, per-client state mutation, the response body — in one
// ~290-line handler whose middle half (the engine-facing half) reached
// into `lib/acp-client.js` and `lib/transcript.js` directly. Three facts
// about that handler are load-bearing and none of them is visible from
// the route's edge any more:
//
//   1. THE BACKFILL DECISION IS A DATA DECISION, NOT A ROUTE DECISION.
//      A stored chat buffer is written when it is empty OR when it looks
//      cumulative (a later `●` line is a strict superset of an earlier
//      one — the segment-accumulator bug, session-isolation/06). A clean
//      stored buffer is kept untouched even though the engine DB is
//      DB-authoritative, because transcript-sync overwrites the stored
//      chat within ~4s anyway and clobbering a clean buffer on EVERY
//      switch is a worse failure than not backfilling. That rule, and
//      the predicate that decides it, belong with the reader that backs
//      it up — not in a route that would have to know the difference.
//
//   2. THE READ MUST NEVER BREAK THE SWITCH. Every transcript failure
//      path — missing db, unloadable better-sqlite3, schema drift, a
//      throwing probe — degrades to "keep the stored chat" and the
//      switch still answers 200. That is the endpoint's oldest promise
//      and it is the reason this family's gate is SOFT (see below): a
//      switch that 501s because an enrichment was unavailable has
//      turned a degraded read into a dead endpoint.
//
//   3. THE WORKSPACE WRITE IS A CONTAINMENT GATED SIDE EFFECT. The
//      target's stored `workspace` is historical input — it may name a
//      directory the user has since removed from the allowed roots. The
//      switch resolves target-first, NEVER falls back to the workspace
//      the user is currently in (that is the reported "file tree still
//      shows the previous project" defect), and refuses with a 400
//      rather than writing a path the picker would have rejected. The
//      gate is `lib/workspace.js#assertWorkspacePath` — the same one
//      `handleWorkspaceChange`, `handleNewSession` and the fs routes use
//      — and it runs BEFORE any `cs` mutation, so a refused switch
//      leaves the client state exactly as it was.
//
// Why this family's gate is SOFT, when the write family (B5) gates hard
// and the tree family (B2) gates hard. The question behind that choice
// is "if the provider declares this capability absent, can the endpoint
// still serve a truthful answer?" — and for #3 the answer is yes:
//
//   - The payload's primary data is webui's OWN store. The record, its
//     title, its chat and its workspace all live in `sessions.json`.
//   - Both engine touches are enrichments that already have a defined
//     degradation: the title falls back to the cache and then to the
//     "Mcode session" placeholder, the transcript falls back to the
//     stored chat. Neither failure is visible as a failure.
//   - Gating hard would REMOVE a working endpoint in response to a
//     declaration about a capability it does not depend on, and it would
//     do so under exactly the transport where the endpoint has the most
//     users. That is B2's `session-export.js` argument, reused rather
//     than re-argued: a missing enrichment must not be dressed up as a
//     failure (#110 fake-success discipline, applied in the other
//     direction).
//
// So `checkSessionSwitchCapability` REPORTS and never throws. The 501
// machinery in `errors.js` stays unused by this family — a policy
// statement, and the suite pins that it stays unused.
//
// What this file deliberately does NOT do:
//
//   - It does not re-implement the transcript. `lib/transcript.js` owns
//     the read and `messagesToChatLines` owns the chat-line grammar; this
//     file owns the DECISION to read and the decision to keep what came
//     back. See KNOWN DEBT 1 for why the 3-candidate probe behind that
//     read survives this batch.
//   - It does not own the workspace boundary. `assertWorkspacePath`
//     stays the single gate every workspace write funnels through.
//   - It does not own the session store. `lib/sessions.js` keeps the
//     load/save and the overlay rule; this file orders the calls.
//   - It does not build a host. There is no host on this path at all.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It statically imports nothing
// heavier than `engine/capabilities.js` and `engine/index.js` (both pure
// declaration modules) and nothing else; `lib/sessions.js`,
// `lib/acp-client.js`, `lib/transcript.js`, `lib/mavis-usage.js`,
// `lib/models.js`, `lib/workspace.js`, `lib/state-bus.js` and
// `lib/config.js` are all reached through `await import()` inside the
// data-plane function. That split is the M1 lesson, and it is what lets
// this module be re-exported from `engine/index.js` at all. The pure
// derivations below take their dependencies as arguments for the same
// reason twice over: they stay testable without a module registry, and
// the boot path never sees a workspace or sqlite import.
//
// Provider selection is M4's job, same as B1 through B5:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// today only `runtime` has one, so under the default `acp` transport the
// gate reports `gate: "unregistered-transport"` and the switch proceeds —
// which is correct, because the pre-M4 behaviour under `acp` is the only
// behaviour this endpoint has ever had.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`, `session-tree-reads.js`,
 * `usage-reads.js`, `account-reads.js` and `session-writes.js`, which
 * this mirrors rather than merges: six families with separate contracts,
 * and a shared table would force this one to inherit another's policy.
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
// The declaration, and the gate policy that goes with it
// ---------------------------------------------------------------------------

/**
 * The declaration this endpoint's ENRICHMENTS need.
 *
 * `sessionCrud` / `getSession` is the honest mapping and it is the same
 * pair B1 uses for `GET /api/acp-session-title` and B2 uses for the
 * export enrichment: reading a session's title and reading its transcript
 * are both reading that session. `usageStats` is deliberately NOT
 * declared, and the reason is worth stating because the switch does
 * touch token usage: `applyMavisUsageToCs` reads webui's OWN mavis usage
 * tables, not a provider method, and it is fire-and-forget — its failure
 * path has been a `catch` with a debug-only warning since before M3. A
 * declaration there would gate a working endpoint on a capability whose
 * absence changes nothing the user can see.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "soft"}>>}
 */
export const SESSION_SWITCH_ENDPOINTS = Object.freeze({
  "POST /api/sessions/switch": Object.freeze({
    capability: "sessionCrud",
    subItem: "getSession",
    enforcement: "soft",
  }),
});

/**
 * Resolve the provider that answers the switch on `transport`, or `null`
 * when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionSwitchProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Read the declaration for this endpoint WITHOUT enforcing it.
 *
 * Returns a descriptor whose `gate` field says what happened:
 *
 *   - `"checked"`               — provider resolved, capability is `full`.
 *   - `"unregistered-transport"` — no provider claims this transport yet.
 *     This is the DEFAULT `acp` transport, and the switch proceeding
 *     here is the pre-M3 behaviour, not a hole in the gate.
 *   - `"capability-absent"`     — the provider WAS found and DOES declare
 *     the capability as `none`. The caller's next move is to degrade the
 *     enrichment (placeholder title, stored chat), never to fail the
 *     request.
 *   - `"partial"`               — provider is `partial` and this sub-item
 *     is absent; the endpoint still degrades, but says so precisely.
 *
 * Deliberately never throws `EngineCapabilityNotSupportedError`. A
 * genuinely unknown endpoint key is still a plain Error — caller
 * confusion is not a capability question, and the HTTP layer must never
 * answer 501 for a typo in webui's own code.
 *
 * @param {string} endpoint  A key of SESSION_SWITCH_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: "soft"}}
 */
export function checkSessionSwitchCapability(endpoint, transport) {
  const need = SESSION_SWITCH_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkSessionSwitchCapability: "${endpoint}" is not part of the session-switch family ` +
        `(known: ${Object.keys(SESSION_SWITCH_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_switch_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveSessionSwitchProvider(transport);
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

// ---------------------------------------------------------------------------
// Pure derivations. Exported and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * The engine's own session-id shape, as this endpoint asks it.
 *
 * The same regex as `session-writes.js#isMcodeSessionId`, spelled again
 * rather than imported: the write family's copy is reachable only
 * through the write gate's module, and a switch that could not run
 * without the delete family's declaration would couple two endpoints
 * that have no reason to move together. The rule itself is one line and
 * both copies are pinned by both suites, so a drift shows up as a red
 * test in whichever family changed, not as a silent behaviour change.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSwitchableMcodeSessionId(id) {
  return typeof id === "string" && /^mvs_[a-f0-9]{32}$/.test(id);
}

/**
 * Resolve a caller-supplied id against the session store.
 *
 * The order is MCODE SID FIRST, then webui uuid — and that is the OPPOSITE
 * of `session-writes.js#resolveSessionTarget`, which is uuid-first. The
 * two are not interchangeable and the difference is a product rule, not a
 * style choice: the switch's whole point is single base-session identity
 * (one conversation, one record — the "extra untitled entry" sidebar
 * confusion the overlay rule was written to kill), so a switch addressed
 * by `mvs_` must land on the record that IS that engine session even if
 * some other record's uuid could be made to match the same string. The
 * delete and rename paths are addressed by a user who already has the
 * record in front of them and look the uuid up first.
 *
 * `matchKind` is `null` — never `"unknown"`, never `""` — exactly when the
 * id resolved to nothing. The caller writes `matchKind || "new_from_mcode"`
 * into the audit payload itself, because that fallback is part of the
 * audit contract and is spelled out at its one call site.
 *
 * @param {Array<object>} records  The loaded session store.
 * @param {string} id              The id from the request.
 * @returns {{index: number, matchKind: "webuiId"|"mcodeSessionId"|null, target: object|null}}
 */
export function resolveSwitchTarget(records, id) {
  const list = Array.isArray(records) ? records : [];
  let index = list.findIndex((s) => s && s.mcodeSessionId === id);
  let matchKind = index >= 0 ? "mcodeSessionId" : null;
  if (index < 0) {
    index = list.findIndex((s) => s && s.id === id);
    if (index >= 0) matchKind = "webuiId";
  }
  return {
    index,
    matchKind,
    target: index >= 0 ? list[index] : null,
  };
}

/**
 * Detect the cumulative-render pollution pattern in a stored chat buffer
 * (session-isolation/06). When the engine emits each segment of an
 * `agent_message`, the stream writer emits a new `●` line; a
 * non-cumulative buffer has each line containing only its own segment's
 * text. A cumulative buffer — the bug — has at least one later `●` line
 * whose text is a strict superset of an earlier `●` line (the accumulator
 * never reset between segments and every later line re-wrote every prior
 * segment's text).
 *
 * This predicate is O(n^2) in the number of `●` lines, but a single
 * session's `chat` is bounded (~400 lines by the transcript cap) so the
 * worst case is a few thousand substring checks per switch — cheap
 * enough to run on the hot path.
 *
 * Conservative on both sides:
 *   - a single-`●`-line buffer is never cumulative;
 *   - non-`●` lines (system, tool, ▲ thought) are ignored — only `●`
 *     rows matter, since the cumulative bug only affects message
 *     segments;
 *   - ties (equal-length `●` lines) are NOT cumulative — same length, no
 *     superset relation.
 *
 * @param {unknown} chat
 * @returns {boolean}
 */
export function chatLooksCumulative(chat) {
  if (!Array.isArray(chat) || chat.length === 0) return false;
  const dots = [];
  for (const line of chat) {
    if (typeof line !== "string") continue;
    // Match the same prefix the streamer writes: `● ` then text. Also
    // accept a bare `●` at end-of-line (transcript-sync appends
    // stripped-down `●` markers in some paths) without treating it as
    // evidence of anything.
    if (line.startsWith("● ")) dots.push(line.slice(2));
  }
  for (let i = 0; i < dots.length; i += 1) {
    for (let j = i + 1; j < dots.length; j += 1) {
      const a = dots[i];
      const b = dots[j];
      if (b.length <= a.length) continue; // strict superset ⇒ longer
      if (b.includes(a)) return true;
    }
  }
  return false;
}

/**
 * Whether the switch should read the engine transcript for a stored
 * buffer, and why — the decision, with no I/O in it.
 *
 * The rule (session-isolation/06) and its three branches:
 *
 *   - stored chat empty → backfill. Unchanged since the first version of
 *     this path: a session that has never been rendered must show its
 *     history, not "No messages yet".
 *   - stored chat looks cumulative → prefer the engine read and
 *     re-persist. The original rule only backfilled when the buffer was
 *     empty, so a polluted buffer persisted via `saveSessions` and won
 *     forever. `reason` reports which branch fired so the operator log
 *     distinguishes "first touch" from "repaired pollution".
 *   - otherwise → keep the stored chat. DB-authoritative:
 *     transcript-sync overwrites the stored chat from the engine within
 *     ~4s, so stored-only lines a user typed but never sent will be lost
 *     regardless, and clobbering a clean buffer on EVERY switch is the
 *     worse failure. This deliberately does NOT promise draft
 *     preservation — the composer keeps its own draft in its own state
 *     (see `composer-draft.test.ts`).
 *
 * @param {unknown} chat  The record's stored `chat` array.
 * @returns {{storedHasChat: boolean, storedCumulative: boolean, shouldBackfill: boolean, reason: "empty"|"stored_cumulative"|"stored_shrinks"|null}}
 */
export function selectTranscriptBackfill(chat) {
  const storedHasChat = Array.isArray(chat) && chat.length > 0;
  const storedCumulative = storedHasChat && chatLooksCumulative(chat);
  if (!storedHasChat) {
    return { storedHasChat, storedCumulative, shouldBackfill: true, reason: "empty" };
  }
  if (storedCumulative) {
    return { storedHasChat, storedCumulative, shouldBackfill: true, reason: "stored_cumulative" };
  }
  return { storedHasChat, storedCumulative, shouldBackfill: false, reason: "stored_shrinks" };
}

/**
 * Resolve the title of an `mvs_…` session from the in-memory
 * walked-session cache, WITHOUT awaiting anything and WITHOUT touching
 * the ACP child.
 *
 * The cache-first rule is a latency rule with a measured number behind
 * it: `getMcodeSessionTitle` boots the ACP child, ~2.17s end-to-end with
 * a broken mcode binary, AND used to degrade the title to the "Mcode
 * session" placeholder even though the cache already held the real one.
 *
 * Cross-workspace matching within what the module exposes: the cache
 * holds ONE workspace's list, keyed by ws. Both the fresh (30s TTL) and
 * the stale (same-ws, TTL-expired) readers are probed, plus the `""`
 * key — the unfiltered list, so a cache walked without a workspace still
 * answers. A miss returns `null` and the caller falls back to
 * `getMcodeSessionTitle`.
 *
 * The two getters are PARAMETERS rather than imports so this stays a
 * pure function over the cache, and so the boot path never reaches
 * `lib/acp-client.js` (which carries the ACP client tree).
 *
 * @param {string} mcodeSessionId
 * @param {string} ws        The workspace the caller is currently in.
 * @param {object} getters   `{fresh, stale}` — the two cache readers.
 * @returns {string|null}
 */
export function lookupCachedMcodeTitle(mcodeSessionId, ws, getters) {
  if (!mcodeSessionId) return null;
  const fresh = getters && getters.fresh;
  const stale = getters && getters.stale;
  if (typeof fresh !== "function" || typeof stale !== "function") return null;
  for (const wsKey of [ws || "", ""]) {
    for (const getter of [fresh, stale]) {
      let sessions = null;
      try {
        sessions = getter(wsKey);
      } catch {
        sessions = null;
      }
      if (!Array.isArray(sessions)) continue;
      const hit = sessions.find(
        (s) => s && s.sessionId === mcodeSessionId && s.title,
      );
      if (hit && hit.title) return hit.title;
    }
  }
  return null;
}

/**
 * Pick the workspace the switched-into session "belongs to" and run it
 * through the same containment gate the workspace picker /
 * `handleNewSession` / `browseWorkspace` all funnel through.
 *
 * Source priority (s39 — webui-parity ticket 39: the file tree must
 * follow the switched session):
 *
 *   1. The target session's stored `workspace` field — that IS the
 *      workspace the user was in when they last had it open, modulo any
 *      pollution the old code introduced. Real existence + containment
 *      are checked; an out-of-bounds or stale value surfaces as a 400
 *      so the user can either widen the allowed roots or pick a fresh
 *      workspace, instead of silently landing on the previous project.
 *
 *   2. `defaultWorkspace` (env `MCODE_WORKSPACE` > mcode TUI cwd.json >
 *      homedir) when the stored value is empty. Empty is also the value
 *      seen for (a) records created by the old code that polluted
 *      freshly-typed mvs sessions with the current `cs.workspace` (the
 *      data-corruption bug this ticket fixes), and (b) older sessions
 *      that pre-date the workspace field. `DEFAULT_WORKSPACE` is already
 *      in the default allowed-roots surface (see
 *      `getAllowedWorkspaceRoots`), so containment accepts it without env
 *      setup.
 *
 * Critical invariants:
 *   - The switch NEVER keeps `cs.workspace` on the prior project. The
 *     user-reported symptom was exactly that: "the file tree still shows
 *     the previous project's files". Falling back to the current
 *     workspace when the target's is empty is the bug being removed —
 *     which is why `currentWs` is NOT a parameter of this function even
 *     though the route still computes it for the log line.
 *   - The switch NEVER writes a path the containment gate rejected. A
 *     400 carrying the gate's actionable error is the only acceptable
 *     outcome.
 *   - The switch NEVER overwrites a target session's stored workspace
 *     with the current one. That was the pollution path; new overlay
 *     records (mvs_ first-touch) get `workspace: ""` and the
 *     target-first read lands on the default for them.
 *
 * Both dependencies are parameters for the same reason as
 * `lookupCachedMcodeTitle`: this is a decision over two values, and it
 * has to be testable — and boot-path-light — without the workspace
 * module and the config module in the graph.
 *
 * @param {object} target            The resolved session record.
 * @param {object} deps
 * @param {string} deps.defaultWorkspace  `DEFAULT_WORKSPACE`.
 * @param {(p: string) => {ok: boolean, path?: string, real?: string, error?: string}} deps.assertPath
 * @returns {{ok: true, dir: string, real: string|undefined, fallback: boolean}|{ok: false, error: string, attempted: string}}
 */
export function resolveSwitchWorkspace(target, deps) {
  const raw =
    target && typeof target.workspace === "string" ? target.workspace.trim() : "";
  // Empty / non-string / null → the default workspace. Never the
  // current one — that is the user-reported "stays on the old project"
  // failure mode this rule removes.
  const candidate = raw || (deps && deps.defaultWorkspace) || "";
  const gate = deps.assertPath(candidate);
  if (!gate.ok) {
    return { ok: false, error: gate.error, attempted: candidate };
  }
  return { ok: true, dir: gate.path, real: gate.real, fallback: !raw };
}

/**
 * The per-client state a switch applies, as a pure field assignment over
 * one client's state object.
 *
 * What it does and does not touch. It sets the identity, the title, the
 * chat buffer, zeroes the three cumulative per-session usage counters
 * and RE-ROOTS the workspace. It is not responsible for `resetContext` —
 * that is a `lib/sessions.js` call with its own mocked parity, and the
 * caller runs it right after, so the ordering (`resetContext` sees the
 * new identity) stays the caller's to keep.
 *
 * `lastUsedWorkspace` is deliberately untouched, and that is a product
 * rule rather than an omission: last-used is written only by the send
 * path (a workspace change / a sent prompt), because switching is
 * browsing. Pinning the browsed workspace to the top of the sidebar is
 * the user-reported "click any session in C and C auto-sorts first"
 * behaviour, and this function is where that is kept true.
 *
 * @param {object} cs  A webui client state. Mutated in place.
 * @param {object} opts
 * @param {object} opts.target  The resolved session record.
 * @param {string} opts.workspaceDir  The containment-gated directory.
 * @returns {object} The same `cs`, for chaining.
 */
export function applySwitchedSessionToClientState(cs, opts) {
  const { target, workspaceDir } = opts;
  cs.sessionId = target.id;
  cs.mcodeSessionId = target.mcodeSessionId || null;
  cs.sessionTitle = target.title || "Untitled";
  cs.chat = Array.isArray(target.chat) ? target.chat : [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  cs.workspace = {
    dir: workspaceDir,
    branch: null,
    tree: null,
  };
  return cs;
}

// ---------------------------------------------------------------------------
// The engine-facing read
// ---------------------------------------------------------------------------

/**
 * Where the transcript read's bytes came from. `engine` when the reader
 * answered with lines; `none` when it did not, and the caller keeps the
 * stored chat. The value exists so a consumer never has to guess.
 *
 * @typedef {"engine" | "none"} SessionSwitchTranscriptSource
 */

/**
 * The switch's one engine-facing read: one session's transcript, mapped
 * into the webui chat-line grammar, best-effort.
 *
 * NEVER THROWS. Every failure — unknown endpoint key aside, which is a
 * caller bug — lands as `{ok: false, reason}` and the caller keeps the
 * stored chat. That containment used to live in a `try/catch` wrapped
 * around the whole block in the route; it is a property of the READ
 * here, so a future caller of this seam cannot get it wrong.
 *
 * `lines` / `messageCount` / `truncated` / `probe` are the reader's own
 * values forwarded verbatim — this facade invents no reason code and
 * never converts a failure into an exception, because the operator log
 * that reports `reason` and the log's own vocabulary are one contract.
 *
 * Async even though the reader is synchronous (better-sqlite3 is sync):
 * the route is already async, and a uniform awaitable `readEngine*`
 * seam means a provider-backed transcript source that IS async (a network
 * engine) needs no signature change at this layer.
 *
 * @param {object} [options]
 * @param {string} [options.mcodeSessionId] The `mvs_…` id to read.
 * @param {string} [options.endpoint]  Endpoint key for the declaration
 *        check; defaults to `/api/sessions/switch`.
 * @param {string} [options.transport] Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @returns {Promise<{mcodeSessionId: string, lines: Array<string>, ok: boolean, reason: string|null, probeTable: string|null, probe: string|null, messageCount: number, truncated: boolean, source: SessionSwitchTranscriptSource, gate: object, transport: string}>}
 */
export async function readEngineSwitchTranscript(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/switch";
  const [transcript, config] = await Promise.all([
    import("../lib/transcript.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = checkSessionSwitchCapability(endpoint, transport);
  const mcodeSessionId = options.mcodeSessionId || "";
  const r = transcript.loadTranscriptChatLines(mcodeSessionId, {
    dbPath: config.MCODE_RUNTIME_DB,
  });
  return {
    mcodeSessionId,
    lines: r.ok && Array.isArray(r.lines) ? r.lines : [],
    ok: r.ok === true,
    reason: r.ok === true ? null : r.reason || "unknown",
    probeTable: r.source || null,
    probe: r.probe || null,
    messageCount: r.messageCount || 0,
    truncated: r.truncated === true,
    source: r.ok === true ? "engine" : "none",
    gate,
    transport,
  };
}

// ---------------------------------------------------------------------------
// Data plane
// ---------------------------------------------------------------------------

/**
 * #3 — the switch.
 *
 * The order below IS the endpoint's contract, and each step is here
 * because moving it would change what the user sees:
 *
 *   1. LOAD + RESOLVE. `mvs_` sid first, then webui uuid (see
 *      `resolveSwitchTarget`).
 *   2. FIRST TOUCH. An `mvs_` sid with no webui record gets ONE overlay
 *      record whose id IS the mvs sid (idempotent create), titled from
 *      the walked-session cache and only then from the engine. An id that
 *      is neither → `not_found` and the route answers 404. Note that an
 *      unresolved id that is NOT an mvs sid is a value, not an error:
 *      the route owns the status code.
 *   3. PLACEHOLDER REPAIR. Wrappers created during the broken-title
 *      window carry "Mcode session" forever; if the walked cache now has
 *      the real title, repair the stored wrapper. Cache-only, and it runs
 *      BEFORE the backfill so the repaired title is what the response
 *      carries.
 *   4. TRANSCRIPT BACKFILL, under `selectTranscriptBackfill`'s rule. The
 *      only step that writes a non-empty buffer, and the only one that
 *      can fail harmlessly.
 *   5. WORKSPACE CONTAINMENT. Runs before ANY `cs` mutation, so a
 *      refused switch (`workspace_refused`) leaves the client exactly as
 *      it was — which is why this outcome exists as a third value next to
 *      `ok` and `not_found` instead of an exception.
 *   6. APPLY. Identity, title, chat, usage counters, workspace — then
 *      `resetContext`, then the fire-and-forget usage sync.
 *
 * The usage sync is started here and NOT awaited, exactly as the route
 * did: it pushes a state frame on its own when it settles, and the
 * switch's own response must not wait on a usage table read.
 *
 * The response body is built HERE and never re-assembled in the route,
 * including the `chat` projection: `runChatViewChat` is a pure read of
 * the run registry and the client state, and nothing between this call
 * and the response mutates either, so computing it one step earlier
 * cannot change a byte. The test suite pins the mid-run case (the
 * run-mirror contract, session-isolation/02) to keep that true.
 *
 * @param {object} options
 * @param {string} options.id    The id from the request; already
 *        validated non-empty by the route.
 * @param {object} options.cs    The requesting client's state. Mutated.
 * @param {string} [options.cid] Requesting client id.
 * @param {string} [options.endpoint]  Endpoint key for the declaration
 *        check; defaults to `/api/sessions/switch`.
 * @param {string} [options.transport] Transport override.
 * @returns {Promise<{outcome: "ok"|"not_found"|"workspace_refused", matchKind: string|null, target: object|null, workspace: object|null, transcript: object|null, audit: object|null, payload: object, statusHint: number, gate: object, transport: string}>}
 */
export async function applyEngineSessionSwitch(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/switch";
  const [sessions, acp, config, workspaceLib, bus, mavis, models] = await Promise.all([
    import("../lib/sessions.js"),
    import("../lib/acp-client.js"),
    import("../lib/config.js"),
    import("../lib/workspace.js"),
    import("../lib/state-bus.js"),
    import("../lib/mavis-usage.js"),
    import("../lib/models.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = checkSessionSwitchCapability(endpoint, transport);
  const { id, cs, cid } = options;
  const all = sessions.loadSessions();
  console.log(
    `[switch] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${isSwitchableMcodeSessionId(id)} allTotal=${all.length}`,
  );
  const { matchKind: foundKind, target: found } = resolveSwitchTarget(all, id);
  let target = found;
  let matchKind = foundKind;
  console.log(
    `[switch] cid=${cid} match=${matchKind || "NONE"} target.id=${target ? target.id.substring(0, 8) : "null"}… target.mcodeSid=${target && target.mcodeSessionId ? target.mcodeSessionId.substring(0, 12) : "null"}… target.chatLen=${target ? (target.chat ? target.chat.length : 0) : 0} target.title="${target ? (target.title || "").substring(0, 30) : ""}"`,
  );

  if (!target) {
    if (!isSwitchableMcodeSessionId(id)) {
      console.log(
        `[switch] cid=${cid} 404 id=${id} not found and not mcode sid`,
      );
      return {
        outcome: "not_found",
        matchKind: null,
        target: null,
        workspace: null,
        transcript: null,
        audit: null,
        payload: { ok: false, error: "session not found" },
        statusHint: 404,
        gate,
        transport,
      };
    }
    // Cache-first title — the walked session cache usually already holds
    // the real title (the sidebar just rendered it). Only a total cache
    // miss pays the `getMcodeSessionTitle` cost.
    const currentWs = (cs && cs.workspace && cs.workspace.dir) || "";
    let title = lookupCachedMcodeTitle(id, currentWs, {
      fresh: acp.getMcodeSessionsCacheSync,
      stale: acp.getMcodeSessionsStaleSync,
    });
    const titleSource = title ? "cache" : "acp";
    if (!title) {
      title = (await acp.getMcodeSessionTitle(id)) || "Mcode session";
    }
    // Single base session — overlay record id === mcode session id,
    // idempotent create. The old model gave each mvs_ switch a fresh uuid
    // wrapper, so the same conversation had two identities, the direct
    // cause of the "extra untitled entry" sidebar confusion.
    //
    // No workspace argument, and none is ever passed: stamping the
    // freshly-created overlay with the CURRENT workspace stamped every
    // first-touch of an mvs session from project A with project A's
    // path, and switching back from project B then either left the file
    // tree stuck on B or overwrote the overlay (s39 / webui-parity 63).
    // New overlays start with `workspace: ""`; the target-first read
    // below lands on the default for them.
    const existed = sessions.findOverlayForMcodeSid(all, id);
    target = sessions.ensureOverlayForMcodeSid(all, id, { title });
    target.updatedAt = Date.now();
    sessions.saveSessions(all);
    // `matchKind` stays `null` here on purpose: the audit payload's
    // `matchKind || "new_from_mcode"` fallback is part of the B01 audit
    // contract, and "new_from_mcode" is the label operators read when a
    // switch invented the wrapper. Labelling it `mcodeSessionId` would
    // rewrite history for every first-touch switch.
    console.log(
      `[switch] cid=${cid} ${existed ? "reused" : "created"} overlay ${target.id.substring(0, 12)}… (id=mcode sid) title="${title}" titleSource=${titleSource}`,
    );
  } else if (
    // Placeholder refresh — wrappers created during a broken-title window
    // carry "Mcode session" forever. If the walked cache now has the real
    // title, repair the stored wrapper. Cache-only (sync, no ACP boot):
    // an existing wrapper must never make the hot path slower.
    target.title === "Mcode session" &&
    target.mcodeSessionId &&
    isSwitchableMcodeSessionId(target.mcodeSessionId)
  ) {
    const cachedTitle = lookupCachedMcodeTitle(
      target.mcodeSessionId,
      (cs.workspace && cs.workspace.dir) || "",
      {
        fresh: acp.getMcodeSessionsCacheSync,
        stale: acp.getMcodeSessionsStaleSync,
      },
    );
    if (cachedTitle) {
      target.title = cachedTitle;
      target.updatedAt = Date.now();
      sessions.saveSessions(all);
      console.log(
        `[switch] cid=${cid} refreshed placeholder title for ${target.id.substring(0, 8)}… → "${cachedTitle}"`,
      );
    }
  }

  // Transcript backfill — when the resolved target has NO webui chat yet
  // but IS a real mvs_ session, load the engine transcript and map it
  // into the webui chat-line grammar BEFORE responding, so the response
  // `session.chat` and `cs.chat` both carry history. Caps inside the
  // reader (last 400 lines / 200KB) keep the SSE state push bounded; a
  // 1000+-message session must not balloon it.
  //
  // FAILURE MUST NOT BREAK SWITCHING: the read is contained in
  // `readEngineSwitchTranscript`, and a failure here logs and continues
  // with the original chat — the switch itself always succeeds.
  let transcript = null;
  if (target.mcodeSessionId && isSwitchableMcodeSessionId(target.mcodeSessionId)) {
    const decision = selectTranscriptBackfill(target.chat);
    if (decision.shouldBackfill) {
      try {
        const read = await readEngineSwitchTranscript({
          mcodeSessionId: target.mcodeSessionId,
          endpoint,
          transport,
        });
        // `decision` is the BRANCH that fired, not the read's outcome —
        // the two answer different questions and the operator log needs
        // both ("we re-read because the buffer was polluted" versus "the
        // re-read found nothing"). It rides on the read's result because
        // that object only exists when a read was actually attempted.
        transcript = { ...read, decision: decision.reason };
        if (transcript.ok && transcript.lines.length > 0) {
          target.chat = transcript.lines;
          target.updatedAt = Date.now();
          sessions.saveSessions(all); // persist the populated wrapper
          console.log(
            `[switch] cid=${cid} transcript backfill ${target.id.substring(0, 8)}… mcode=${target.mcodeSessionId.substring(0, 12)}… reason=${decision.reason} lines=${transcript.lines.length} msgs=${transcript.messageCount} probe=${transcript.probe}${transcript.truncated ? " (capped)" : ""}`,
          );
        } else if (!transcript.ok) {
          console.log(
            `[switch] cid=${cid} transcript unavailable for ${target.mcodeSessionId.substring(0, 12)}… reason=${transcript.reason || "unknown"}`,
          );
        } else if (decision.storedCumulative) {
          // Cumulative buffer + the read came back empty — preserve the
          // stored chat (which is at least the user's last view) and log
          // the discrepancy so a post-mortem can see what happened.
          console.log(
            `[switch] cid=${cid} stored chat looked cumulative but the transcript read returned no lines; preserving stored chat for ${target.mcodeSessionId.substring(0, 12)}…`,
          );
        }
      } catch (e) {
        // Belt and braces: the read is written not to throw, but a
        // module-load failure in the dynamic import would land here, and
        // a switch that 500s because a transcript could not be loaded is
        // the failure mode this endpoint has never had.
        console.warn(
          `[switch] cid=${cid} transcript backfill failed for ${target.mcodeSessionId.substring(0, 12)}… (continuing with stored chat):`,
          e && e.message ? e.message : e,
        );
      }
    }
  }

  const prevSid = cs.sessionId;
  // s39: resolve the target session's workspace and re-point
  // `cs.workspace.dir` to it BEFORE any other cs mutation, so the SSE
  // state push and the response payload both carry the new workspace in
  // lockstep with the session-id switch. The pre-fix behaviour read
  // `cs.workspace` without writing it, which left the file tree bound to
  // the previous project.
  const switchWs = resolveSwitchWorkspace(target, {
    defaultWorkspace: config.DEFAULT_WORKSPACE,
    assertPath: workspaceLib.assertWorkspacePath,
  });
  if (!switchWs.ok) {
    console.log(
      `[switch] cid=${cid} REFUSED id=${id.substring(0, 12)}… reason=workspace_containment attempted="${switchWs.attempted}"`,
    );
    return {
      outcome: "workspace_refused",
      matchKind,
      target,
      workspace: switchWs,
      transcript,
      audit: null,
      payload: {
        ok: false,
        error: switchWs.error,
        attempted: switchWs.attempted,
      },
      statusHint: 400,
      gate,
      transport,
    };
  }
  if (switchWs.fallback) {
    console.log(
      `[switch] cid=${cid} target ${target.id.substring(0, 8)}… had no workspace — fell back to DEFAULT_WORKSPACE=${switchWs.dir}`,
    );
  }
  applySwitchedSessionToClientState(cs, { target, workspaceDir: switchWs.dir });
  sessions.resetContext(cs);
  // Sync real token usage from the mavis db on switch to a historical
  // session. Fire-and-forget, exactly as before: its failure path is a
  // debug-only warning and the switch's own response must not wait on a
  // usage table read.
  if (cs.mcodeSessionId) {
    const switchedSid = cs.mcodeSessionId;
    mavis
      .applyMavisUsageToCs(cs, switchedSid, { getMcodeModelLimit: models.getMcodeModelLimit })
      .then(() => bus.pushStateFor(cid))
      .catch((e) => {
        if (process.env.MCODE_USAGE_DEBUG)
          console.warn(`[switch.mavis] cid=${cid} error: ${e.message}`);
      });
  }
  return {
    outcome: "ok",
    matchKind,
    target,
    workspace: switchWs,
    transcript,
    // The audit event. B01: a switch records which session was activated
    // and from which prior session, plus (s39) which workspace the switch
    // landed on and whether that was the DEFAULT_WORKSPACE fallback —
    // both useful when auditing "why did the file tree change" or "why is
    // the sidebar sorting by a directory I never opened". The route
    // appends it and owns the fail-closed 500, because the write-ahead
    // ordering between "know what to switch to" and "tell anyone" is the
    // route's to keep.
    audit: {
      event: "session.switch",
      target: cs.sessionId,
      cid,
      actor: "user",
      payload: {
        from: prevSid || "",
        matchKind: matchKind || "new_from_mcode",
        mcodeSessionId: cs.mcodeSessionId || "",
        title: cs.sessionTitle,
        workspace: switchWs.dir,
        workspaceFallback: !!switchWs.fallback,
      },
    },
    payload: {
      ok: true,
      session: {
        id: target.id,
        mcodeSessionId: cs.mcodeSessionId,
        title: cs.sessionTitle,
        // s39: surface the new workspace in the response so the client
        // (url-restore + session-tree) can update its in-memory state
        // without waiting for the SSE state-bus push to land.
        workspace: switchWs.dir,
        workspaceFallback: !!switchWs.fallback,
        // session-isolation/02 (run-mirror): switching back to the
        // session that is mid-run must show what it produced so far.
        chat: bus.runChatViewChat(cid, cs),
      },
    },
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
//   1. THE 3-CANDIDATE TRANSCRIPT PROBE IS STILL HERE, and this batch is
//      the batch the plan named for retiring it (plan §7: "transcript DB
//      探针 … → getMessages"). It could not be retired without breaking
//      this batch's own red line, and the reason is not a matter of taste:
//
//        a. THE DEFAULT TRANSPORT HAS NO ENGINE SURFACE. The `acp`
//           transport is the default and NO provider is registered for
//           it — `providerByTransport()` returns `{runtime: …}` only,
//           precisely so this gate reports
//           `gate: "unregistered-transport"` and the pre-M3 behaviour
//           survives. `cliService.getMessages` is reachable only through
//           the v2 catalogue host, which only the `runtime` transport
//           boots. Deleting the probe therefore empties the backfill on
//           the default transport and on half of the two-transport test
//           matrix this batch is gated on. That is red line 1
//           (转录回填) failing, not a refactor completing.
//        b. THE TWO READS CAP DIFFERENT THINGS. The probe reads a whole
//           session and caps the mapped LINES at 400 / 200KB
//           (`messagesToChatLines`). `getMessages` paginates —
//           `limit`, `before`, `nextCursor`, `hasMore` — so it caps
//           MESSAGES. The two are interchangeable only after proving
//           that the tail of a bounded message page yields the same
//           400 lines, which needs a live v2 host to measure.
//        c. THE ORDERING IS NOT THE SAME ORDERING. The probe orders
//           `created_at_ms ASC, rowid ASC`; `getMessages` orders by
//           `MessageQueryService`'s own key. On ties the two disagree,
//           and a transcript whose order flips is a transcript the user
//           reads wrong.
//        d. EXPORT STILL OWNS THE LEGACY CANDIDATES. B2 left
//           `GET /api/sessions/:id/export` on the legacy-only probe set
//           on purpose — its `mcode_unavailable` shape is byte-pinned by
//           existing tests against exactly those three candidates, and
//           widening export's set would change its enrichment from
//           "unavailable" to "answering", which is a product change, not
//           a migration step.
//
//      What this batch DID collect is the coupling that made the probe
//      look unremovable: `routes/sessions.js` no longer names
//      `lib/transcript.js` at all, the read has one seam
//      (`readEngineSwitchTranscript`), and the 3-candidate list plus the
//      v2 data_json probe are now an implementation detail of the engine
//      layer rather than something two routes import directly. The
//      remaining work is a SEAM SWAP, not a redesign, and it belongs to
//      M4-1 — the batch that registers an ACP provider and therefore
//      makes an engine surface reachable under the default transport.
//      It should land together with an equivalence test against a live v2
//      host, and with export's probe set widened in the same commit so
//      the two endpoints cannot drift apart again.
//
//   2. THE FIRST-TOUCH OVERLAY IS STILL A WEBUI-SIDE WRITE. A bare
//      `mvs_…` switch creates a record in `sessions.json` that the
//      engine knows nothing about, and the engine's own session list and
//      webui's wrapper list are two different questions that happen to
//      agree. This is pre-existing behaviour (the alternative —
//      registering the session engine-side — is a product decision about
//      who owns session identity), and this batch did not change it.
//
//   3. THE USAGE SYNC IS NOT GATED. `applyMavisUsageToCs` reads webui's
//      own mavis tables, so it declares no capability, and its failure
//      is still swallowed with a debug-only warning. That asymmetry —
//      identity and transcript are degraded, usage is dropped silently —
//      predates this batch. Naming `usageStats` here would gate a working
//      endpoint on a capability whose absence changes nothing visible;
//      the real question is whether a silent drop is the right product
//      behaviour at all, and that is not this batch's to decide.
