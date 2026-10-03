// webui/server/engine/session-writes.js
//
// Migration step M3, batch B5: the session WRITE family (会话写族) — the
// three endpoints that change stored state rather than read it:
//
//   #7  DELETE /api/sessions/:id          — delete a session
//   #4  POST  /api/sessions/rename        — rename a session
//   #6  POST  /api/sessions/cleanup-orphans — sweep default-named empties
//
// Why a write family needs a facade at all, when a read family is a
// one-liner that forwards. #7 is the only endpoint in the whole migration
// that can DESTROY data the engine owns, and it destroys it three ways
// at once: the engine's own `local_runtime_*` rows, the webui session
// record, and the in-memory caches two readers are assembled from. Three
// facts about that delete are load-bearing and none of them is visible
// at the call site once the route has grown to 270 lines:
//
//   1. THE RESURRECTION GUARD. The long-lived mcode ACP child holds the
//      session in memory and rewrites its registry row on the next
//      request, so a delete that only removes SQL rows comes BACK. The
//      order is the whole mechanism: kill the child → delete the rows →
//      drop ONLY the deleted sid from the cache (not the whole cache —
//      invalidating everything flashes the sidebar 42 → 16 → 42 and
//      reads to the user like the delete failed). A refactor that
//      reorders these three steps reintroduces "deleted session
//      reappears" without failing any single assertion.
//   2. CACHE INVALIDATION PRECEDES THE ENGINE WRITE.
//      `invalidateSessionTree()` runs before the engine delete so the
//      next read cannot repopulate a cache from a database this call is
//      about to change. Same reason, same asymmetry.
//   3. THE CROSS-TAB FAN-OUT. Every client whose `sessionId` or
//      `mcodeSessionId` pointed at the deleted record has its active
//      session cleared and its usage counters zeroed, because the next
//      interaction in that tab would otherwise silently recreate a webui
//      wrapper for the very `mvs_` sid that was just deleted. The
//      orphan branch clears only the REQUESTING client, because an
//      orphan mcode session has no wrapper for another tab to be
//      "inside". That asymmetry is real and load-bearing; flattening it
//      would clear tabs that were never on the deleted session.
//
// So the sequencing lives here, named, and tested on its steps; the route
// keeps what is genuinely its own — HTTP parsing, the `authorize()`
// modal, the write-ahead audit ordering, and every status code.
//
// The SQL moved in M4-3a, and this file stopped issuing it.
// `lib/mcode-session-delete.js` — the module that opened the runtime
// database and issued a row-destroying DELETE against a hand-curated list
// of 32 `local_runtime_*` tables inside one hand-rolled transaction — is
// GONE. The destructive step is now the engine's own `deleteSession`,
// reached from the sibling data-plane module `engine/session-delete.js`
// (whose header records what that call is and why the read-only half
// stayed). That module is reached through `await import()`, the same
// boot-path discipline B3 and B4 drew, so this file still statically
// imports nothing heavier than `capabilities.js` and `index.js`.
//
// What M4-3a did NOT do, and the reason is worth stating because it is the
// one place a reader will suspect hand-waving: webui no longer names an
// engine table for the purpose of DESTROYING anything, but it still names
// them to COUNT, because the engine has no preview form of the delete and
// `?dryRun=true` is part of the endpoint's contract. Read-only knowledge
// of the schema stayed; write access to it did not. See KNOWN DEBT 1 of
// `engine/session-delete.js`.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. `lib/sessions.js`,
// `lib/acp-client.js`, `lib/config.js`, `lib/session-tree.js`,
// `lib/state-bus.js` and `lib/session-delete.js` are all reached through
// `await import()` inside the functions. That split is the M1 lesson, and
// it is what lets this module be re-exported from `engine/index.js` at
// all.
//
// Provider selection is M4's job, same as B1 through B4:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// today only `runtime` has one, so under the default `acp` transport the
// gate reports `gate: "unregistered-transport"` and the write proceeds —
// which is correct, because the pre-M4 behaviour under `acp` is the
// only behaviour these endpoints have ever had.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

// `node:fs` is a builtin, not a project dependency, and `usage-reads.js`
// already reaches for it at module scope for the same reason. It is here
// for exactly two calls: the orphan sweep's "is there a sessions store
// at all" probe and its BOM-tolerant read.
import { existsSync, readFileSync } from "node:fs";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`,
 * `session-tree-reads.js#providerByTransport`,
 * `usage-reads.js#providerByTransport` and
 * `account-reads.js#providerByTransport`, which this mirrors rather than
 * merges: the five families have separate contracts, and a shared table
 * would force the write family to inherit a read family's policy.
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
 * The declaration each endpoint of this family needs, the sub-item it
 * needs from that capability, and HOW that declaration is enforced.
 *
 * The third field is this family's own addition, and it is not
 * decoration — the hard/soft question for a write is decided by WHO
 * OWNS THE ROWS THE WRITE DESTROYS, which is a different question from
 * the read families' "is the data engine data or webui data", and it
 * does not have the same answer twice in a row here:
 *
 *   - #7 DELETE — **hard** on `sessionCrud` · `deleteSession`. The write
 *     destroys rows in the ENGINE's own `local_runtime_*` tables. There
 *     is no webui-side copy of a transcript that survives: once those
 *     rows are gone, the conversation is gone. A provider that declares
 *     no session deletion genuinely cannot have this endpoint serve a
 *     truthful answer, and the honest one is the 501 that
 *     `app.js#invokeHandler` derives from
 *     `EngineCapabilityNotSupportedError`. This is B4's account-read
 *     reasoning applied to a write: the data has exactly one owner, and
 *     it is not us.
 *
 *   - #6 cleanup-orphans — **hard** on the SAME
 *     `sessionCrud` · `deleteSession` pair, deliberately. The sweep
 *     selects webui-side orphan RECORDS, but each selected id is fed
 *     through #7's real-delete branch, and a record carrying an
 *     `mcodeSessionId` takes the engine's rows down with it. Gating the
 *     sweep soft would mean a provider that cannot delete engine
 *     sessions could still reach the engine's tables through a back
 *     door — the exact shape this batch exists to close. A sweep that
 *     authorizes, writes its intent audit event and then fails every
 *     single delegated delete is also the fake-success shape: an
 *     authorized destructive action that accomplished nothing.
 *
 *   - #4 rename — **no capability at all**, and this row is the one a
 *     reader will double-take, so here is the whole argument. Rename
 *     writes `item.title` / `item.titleCustom` / `item.updatedAt` into
 *     webui's OWN session store and nothing else: not the engine, not
 *     `local_runtime_sessions`, not any provider method. Its one engine
 *     touch is `invalidateSessionTree()`, a cache drop — the read-side
 *     consequence of the sidebar projecting titles from the engine, and
 *     the projection itself is B2's `GET /api/session-tree`, which
 *     carries its own gate. Naming a capability here would be a lie of
 *     the same kind B3 declined for `GET /api/usage/forecast`: a write
 *     that touches no engine surface must not be gated on an engine
 *     declaration, because gating it hard would remove a working
 *     endpoint in response to a statement about something it does not
 *     depend on. Note what this row also records about the product: a
 *     rename is a webui-side LABEL, and the engine's own title is not
 *     touched. That is pre-existing behaviour and this batch does not
 *     change it — see KNOWN DEBT at the end of this header.
 *
 * Every row carries all three keys, including the row that has no
 * capability. B3 expressed "no engine surface" as a `null` table entry;
 * this family has three endpoints of which two DO cross the seam, and a
 * `null` hole in the middle of the table is the kind of shape a later
 * edit mistakes for "not filled in yet". Uniform rows make the
 * enforcement decision reviewable as one diff.
 *
 * @typedef {{capability: string|null, subItem: string|null, enforcement: "hard"|"soft"|"none"}} SessionWriteDeclaration
 * @type {Readonly<Record<string, SessionWriteDeclaration>>}
 */
export const SESSION_WRITE_ENDPOINTS = Object.freeze({
  "DELETE /api/sessions/:id": Object.freeze({
    capability: "sessionCrud",
    subItem: "deleteSession",
    enforcement: "hard",
  }),
  "POST /api/sessions/rename": Object.freeze({
    capability: null,
    subItem: null,
    enforcement: "none",
  }),
  "POST /api/sessions/cleanup-orphans": Object.freeze({
    capability: "sessionCrud",
    subItem: "deleteSession",
    enforcement: "hard",
  }),
});

/**
 * Resolve the provider that answers session writes on `transport`, or
 * `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveSessionWriteProvider(transport) {
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
 * Every row of `SESSION_WRITE_ENDPOINTS` is enforced at the strength its
 * `enforcement` field names, and today only `"hard"` rows can throw:
 * `"soft"` reports and returns (B2's `session-export.js` policy, for a
 * family that has no soft row yet — the field is declared uniform so
 * that adding one is a table edit rather than a signature change), and
 * `"none"` never consults the provider at all.
 *
 * @param {string} endpoint  A key of SESSION_WRITE_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: string}}
 */
export function assertSessionWriteCapability(endpoint, transport) {
  const need = SESSION_WRITE_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation — a plain Error so the
    // HTTP layer never answers 501 for a typo in webui's own code.
    const err = new Error(
      `assertSessionWriteCapability: "${endpoint}" is not part of the session write family ` +
        `(known: ${Object.keys(SESSION_WRITE_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_session_write_endpoint";
    throw err;
  }
  const provider = resolveSessionWriteProvider(transport);
  if (need.capability === null) {
    return {
      endpoint,
      gate: "no-capability-key",
      provider: provider ? provider.id : null,
      capability: null,
      subItem: null,
      enforcement: need.enforcement,
    };
  }
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
  assertEngineCapability(provider.capabilities, need.capability, provider.id, need.subItem);
  return {
    endpoint,
    gate: "checked",
    provider: provider.id,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
}

// ---------------------------------------------------------------------------
// Pure derivations. Exported and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * The engine's own session-id shape. Four call sites in the pre-facade
 * delete path spelled this regex out inline, which is how a fifth call
 * site eventually spelled it with a different quantifier. It is the
 * predicate that separates "an id the engine minted" (orphan branch:
 * delete the engine's rows directly) from "an id webui minted" (wrapper
 * branch), so it is named rather than repeated.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isMcodeSessionId(id) {
  return typeof id === "string" && /^mvs_[a-f0-9]{32}$/.test(id);
}

/**
 * Resolve a caller-supplied id against the session store: by webui uuid
 * first, then by the engine sid a record is bound to.
 *
 * This is the single-identity rule made explicit, and it was duplicated
 * verbatim in `handleRenameSession` and `handleDeleteSession` before
 * this batch — the same eleven lines, twice, with the same three
 * possible answers. A third write endpoint would have been a third copy,
 * and the copy that drifts is the one where a rename resolves a session
 * the delete path cannot find, or the reverse.
 *
 * `matchKind` is `null` — never `"unknown"`, never `""` — exactly when
 * the id resolved to nothing. Callers that need a label for the audit
 * payload write `matchKind || "unknown"` themselves, because the two
 * places that do (#7's `authorize()` context and #7's intent event)
 * spell that fallback out and it is part of the audit contract.
 *
 * @param {Array<object>} records  The loaded session store.
 * @param {string} id              The id from the request.
 * @returns {{index: number, matchKind: "webuiId"|"mcodeSessionId"|null, target: object|null}}
 */
export function resolveSessionTarget(records, id) {
  const list = Array.isArray(records) ? records : [];
  let index = list.findIndex((s) => s && s.id === id);
  let matchKind = index >= 0 ? "webuiId" : null;
  if (index < 0) {
    index = list.findIndex((s) => s && s.mcodeSessionId === id);
    if (index >= 0) matchKind = "mcodeSessionId";
  }
  return {
    index,
    matchKind,
    target: index >= 0 ? list[index] : null,
  };
}

/**
 * The staleness window the orphan sweep uses — 24h. Matches
 * `lib/sessions.js#cleanupEmptyDefaultSessions`, which prunes the same
 * class of leftover at startup; the sweep endpoint and the startup pass
 * agree on what "leftover" means, and a future edit that moves one of
 * them must move both.
 */
export const ORPHAN_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The "empty AND default-titled AND older than a day" rule behind
 * `POST /api/sessions/cleanup-orphans`, as a pure predicate over ONE
 * record. Split out of the store read so the rule is testable without a
 * file and so the threshold is named rather than inlined at the filter
 * site.
 *
 * `(record.title || "").trim()` is kept exactly as it was, including its
 * behaviour on a non-string truthy title (a `TypeError`, which
 * propagates out of the sweep as it always has). Tightening it here
 * would be a behaviour change dressed as a hardening, and this batch
 * promises none.
 *
 * @param {object} record
 * @param {number} now            Epoch ms, injected so the rule is pure.
 * @param {number} staleMs        The staleness threshold.
 * @returns {boolean}
 */
export function isOrphanSessionRecord(record, now, staleMs) {
  if (!record || !record.id) return false;
  const hasChat = Array.isArray(record.chat) && record.chat.length > 0;
  if (hasChat) return false;
  const title = (record.title || "").trim();
  const isDefault =
    title === "New session" || title === "Untitled" || /^对话 \d+$/.test(title);
  if (!isDefault) return false;
  if (record.updatedAt && now - record.updatedAt < staleMs) return false;
  return true;
}

/**
 * The ids `POST /api/sessions/cleanup-orphans` would delete, in store
 * order, under `isOrphanSessionRecord`.
 *
 * @param {Array<object>} records
 * @param {object} [options]
 * @param {number} [options.now]     Epoch ms; defaults to `Date.now()`.
 * @param {number} [options.staleMs] Defaults to `ORPHAN_STALE_MS`.
 * @returns {string[]}
 */
export function selectOrphanSessionIds(records, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const staleMs = options.staleMs === undefined ? ORPHAN_STALE_MS : options.staleMs;
  const list = Array.isArray(records) ? records : [];
  return list.filter((s) => isOrphanSessionRecord(s, now, staleMs)).map((s) => s.id);
}

/**
 * The per-client state reset a delete fans out, as a PURE field
 * assignment over one client's state object.
 *
 * Note what it does and does not touch. It clears the identity
 * (`sessionId`, `mcodeSessionId`), the title and the chat buffer. It is
 * not responsible for `resetContext` — that is a `lib/sessions.js` call
 * with its own mocked parity in the test helper, and the caller runs it
 * right after this so the ordering (`resetContext` sees the cleared
 * identity) is the caller's to keep.
 *
 * `resetUsage` exists because the two delete branches genuinely differ
 * here and the difference predates this batch. The wrapper branch zeroes
 * the three cumulative session-usage counters, because the tab was
 * showing a real session's spend and must stop. The orphan branch does
 * NOT, because an orphan mcode session has no webui record and no tab
 * can have accumulated webui-side per-session usage against it. Zeroing
 * them there would be harmless; unifying the two branches is a product
 * decision, not a refactor, so the asymmetry is a parameter with a
 * comment rather than a silent difference between two call sites.
 *
 * @param {object} cs  A webui client state. Mutated in place — every
 *        consumer of this predicate is already mutating `cs` in place.
 * @param {object} [options]
 * @param {boolean} [options.resetUsage]  Default true (the wrapper
 *        branch). False for the orphan branch; see above.
 * @returns {object} The same `cs`, for chaining.
 */
export function applyDeletedSessionToClientState(cs, options = {}) {
  const resetUsage = options.resetUsage !== false;
  cs.sessionId = null;
  cs.mcodeSessionId = null;
  cs.sessionTitle = "Untitled";
  cs.chat = [];
  if (resetUsage) {
    cs.usage = {
      ...cs.usage,
      sessionInput: 0,
      sessionOutput: 0,
      sessionTotal: 0,
    };
  }
  return cs;
}

/**
 * The per-client title fan-out a rename performs, as a pure assignment.
 * Extracted for the same reason as the delete reset: the rename path
 * runs it once per client whose identity matches, and a test that wants
 * to prove "the other tab's title changed too" should be able to point at
 * a named predicate instead of re-deriving the match rule.
 *
 * @param {object} cs
 * @param {string} title  The new title, already trimmed and validated.
 * @returns {object} The same `cs.
 */
export function applyRenamedSessionToClientState(cs, title) {
  cs.sessionTitle = title;
  return cs;
}

/**
 * Whether a client is inside the record a RENAME is renaming, and so
 * needs its title pushed. Matches on the record's webui id OR on the
 * engine sid THE RECORD is bound to.
 *
 * This is deliberately NOT the same predicate as
 * `clientMatchesDeletedSession`, even though both were one inline
 * condition before this batch. They differ on the second clause, and the
 * difference is load-bearing in both directions:
 *
 *   - rename matches `record.mcodeSessionId`, because the record is the
 *     subject and every tab that adopted that engine session should see
 *     the new label.
 *   - delete matches the REQUEST id, because a tab is only "inside" the
 *     deletion if it is pointing at what the user asked to delete. A
 *     tab bound to the record's engine sid under a different webui id is
 *     a different wrapper record and must not be cleared.
 *
 * Merging them would either resurrect a wrapper in a tab the user just
 * cleared, or blank the title of an unrelated tab. They stay two
 * predicates, each named for the branch that uses it.
 *
 * @param {object} cs
 * @param {object} record  The session record being renamed.
 * @returns {boolean}
 */
export function clientMatchesRenamedSession(cs, record) {
  if (!cs || !record) return false;
  if (cs.sessionId === record.id) return true;
  return !!(record.mcodeSessionId && cs.mcodeSessionId === record.mcodeSessionId);
}

/**
 * Whether a client is inside the session a DELETE removed, and so needs
 * its active session cleared. Matches on the record's webui id OR on the
 * id the request named. See `clientMatchesRenamedSession` for why this
 * is not the same predicate.
 *
 * @param {object} cs
 * @param {object} record     The deleted record; `null` for the orphan
 *        branch, where there is no record to match against.
 * @param {string} requestId  The id the caller asked to delete.
 * @returns {boolean}
 */
export function clientMatchesDeletedSession(cs, record, requestId) {
  if (!cs) return false;
  if (record && cs.sessionId === record.id) return true;
  return !!requestId && cs.mcodeSessionId === requestId;
}

// ---------------------------------------------------------------------------
// Data-plane writes
// ---------------------------------------------------------------------------

/**
 * Load the store and resolve the requested id, without mutating
 * anything. This is the half of #7 that has to happen BEFORE
 * `authorize()` (the modal is shown for a specific record with a
 * specific match kind and chat length) and before the write-ahead intent
 * audit (which records the same three facts).
 *
 * Splitting plan from commit is what keeps the audit chain intact. The
 * route must be able to interleave a governance decision and a durable
 * event between "know what the user asked to delete" and "delete it",
 * and a facade that owned the whole operation would have swallowed that
 * ordering into a callback. Nothing here touches the database, the
 * store, the caches or any client state.
 *
 * @param {object} options
 * @param {string} options.id          The requested id.
 * @param {string} [options.endpoint]  Endpoint key for the declaration
 *        check; defaults to `/api/sessions/:id`.
 * @param {string} [options.transport] Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @returns {Promise<{id: string, records: Array<object>, index: number, matchKind: string|null, target: object|null, isOrphan: boolean, chatLen: number, gate: object, transport: string}>}
 */
export async function planEngineSessionDelete(options = {}) {
  const endpoint = options.endpoint || "DELETE /api/sessions/:id";
  const [sessions, config] = await Promise.all([
    import("../lib/sessions.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertSessionWriteCapability(endpoint, transport);
  const records = sessions.loadSessions();
  const { index, matchKind, target } = resolveSessionTarget(records, options.id);
  return {
    id: options.id,
    records,
    index,
    matchKind,
    target,
    isOrphan: index < 0,
    // `target && Array.isArray(target.chat)` rather than
    // `Array.isArray(target?.chat)`: a store record that is not an
    // object must read as "no chat", and the audit payload's `chatLen`
    // has always been 0 for that case.
    chatLen: index >= 0 && target && Array.isArray(target.chat) ? target.chat.length : 0,
    gate,
    transport,
  };
}

/**
 * #7's orphan branch: the id is an `mvs_…` sid with NO webui record, so
 * there is no wrapper to remove and the only thing to delete is the
 * engine's own rows.
 *
 * The resurrection guard and the cache drop are ordered deliberately and
 * the order is the feature (see this file's header): kill the child
 * that would rewrite the registry row, then delete, then drop the ONE
 * cache entry — never the whole cache.
 *
 * `dryRun` suppresses the kill and the cache drop, because a preview
 * mutates nothing and a preview that shuts down the user's ACP child is
 * a side effect the `?dryRun=true` contract does not include. The COUNT
 * still runs, read-only, inside `engine/session-delete.js`.
 *
 * The requesting client is reset when — and only when — it was
 * currently sitting on that sid. No other tab can be: an orphan has no
 * webui record for a tab to be inside.
 *
 * @param {object} options
 * @param {object} options.plan    A `planEngineSessionDelete` result.
 * @param {object} [options.cs]    The requesting client's state.
 * @param {string} [options.cid]   Requesting client id, for the state push.
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{mcodeDbDel: object, payload: object, failed: boolean}>}
 */
export async function commitEngineOrphanSessionDelete(options = {}) {
  const { plan, cs, cid, dryRun = false } = options;
  const [deleter, config, acp, tree, bus, sessions] = await Promise.all([
    import("./session-delete.js"),
    import("../lib/config.js"),
    import("../lib/acp-client.js"),
    import("../lib/session-tree.js"),
    import("../lib/state-bus.js"),
    import("../lib/sessions.js"),
  ]);
  const id = plan.id;
  if (!dryRun) {
    // The child shutdown is wrapped in try/catch exactly as the
    // pre-facade `killMcodeSessionResurrection` wrapped it: a live child
    // that refuses to die must not abort the delete that follows. The
    // cache drop is not wrapped, because a cache that cannot be dropped
    // is the resurrection this branch exists to prevent.
    try {
      acp.shutdownMcodeAcpSingleton();
    } catch {}
    acp.dropMcodeSessionFromCache(id);
  }
  // M4-3a: the engine owns the delete. A dry run stays a COUNT (the engine
  // has no preview form); a real one asks the engine. The `await` is new
  // — the retired SQL call was synchronous — and it is confined to this
  // line: the sequence around it, which is the feature, is untouched.
  const mcodeDbDel = dryRun
    ? deleter.previewSessionDeleteRows(id, {
        MCODE_RUNTIME_DB: config.MCODE_RUNTIME_DB,
      })
    : await deleter.deleteSessionThroughEngine(id, {
        MCODE_RUNTIME_DB: config.MCODE_RUNTIME_DB,
      });
  if (!dryRun) tree.invalidateSessionTree();
  if (!mcodeDbDel.ok) {
    return {
      mcodeDbDel,
      failed: true,
      payload: { ok: false, error: "orphan mcode delete failed", mcodeDbDel },
    };
  }
  if (cs && cs.mcodeSessionId === id) {
    // `resetUsage: false` — see `applyDeletedSessionToClientState`. An
    // orphan has no webui record, so no tab accumulated per-session
    // usage against it.
    applyDeletedSessionToClientState(cs, { resetUsage: false });
    sessions.resetContext(cs);
    bus.pushStateFor(cid);
  }
  return {
    mcodeDbDel,
    failed: false,
    payload: {
      ok: true,
      deleted: id,
      matchKind: "orphan_mcode",
      dryRun,
      mcodeDbDel,
    },
  };
}

/**
 * #7's `?dryRun=true` preview for a record that DOES have a webui
 * wrapper: the readonly per-table count for the linked engine session,
 * plus the webui entry that WOULD be removed. Nothing is written, no
 * child is killed, no cache is dropped.
 *
 * A record with no `mcodeSessionId` (a webui-only session that never
 * reached the engine) still previews — with an empty log and zero rows,
 * the same literal the pre-facade route used to inline. A preview that
 * refused to answer for those would be a new failure mode.
 *
 * @param {object} options
 * @param {object} options.plan  A `planEngineSessionDelete` result.
 * @returns {Promise<{mcodeDbDel: object, payload: object}>}
 */
export async function previewEngineSessionDelete(options = {}) {
  const { plan } = options;
  const [deleter, config] = await Promise.all([
    import("./session-delete.js"),
    import("../lib/config.js"),
  ]);
  const mcodeSid = plan.target ? plan.target.mcodeSessionId : undefined;
  const mcodeDbDel = mcodeSid
    ? deleter.previewSessionDeleteRows(mcodeSid, {
        MCODE_RUNTIME_DB: config.MCODE_RUNTIME_DB,
      })
    : { ok: true, dryRun: true, log: [], totalRows: 0 };
  return {
    mcodeDbDel,
    payload: {
      ok: true,
      dryRun: true,
      matchKind: plan.matchKind,
      mcodeDbDel,
      webuiEntryWouldBeDeleted: {
        id: plan.target.id,
        title: plan.target.title,
        mcodeSessionId: mcodeSid,
      },
    },
  };
}

/**
 * #7's real delete of a record that HAS a webui wrapper: splice the
 * store, persist it, drop the tree cache, mirror the delete on the
 * engine, then fan the cleared state out to every tab that was inside
 * the record.
 *
 * The order is load-bearing in three places, all noted above: the tree
 * cache is dropped BEFORE the engine write so a concurrent read cannot
 * repopulate it from the pre-delete database; the engine mirror runs
 * only when the record carries an `mcodeSessionId` (a webui-only session
 * has no engine rows, and calling the deleter with `undefined` would
 * report `not_mcode_sid` into the audit payload as if it had failed);
 * and the fan-out runs AFTER both, so a tab is never told its session is
 * gone while the rows still exist.
 *
 * `touchedCids` falls back to `[cid]` when no tab matched. That is not a
 * no-op: it guarantees the requesting tab always gets a state push, so
 * the client cannot be left rendering a session the server has already
 * deleted.
 *
 * @param {object} options
 * @param {object} options.plan  A `planEngineSessionDelete` result.
 * @param {string} [options.cid] Requesting client id.
 * @returns {Promise<{deletedItem: object, records: Array<object>, mcodeDbDel: object|null, touchedCids: string[], payload: object}>}
 */
export async function commitEngineSessionDelete(options = {}) {
  const { plan, cid } = options;
  const [deleter, config, acp, tree, bus, sessions] = await Promise.all([
    import("./session-delete.js"),
    import("../lib/config.js"),
    import("../lib/acp-client.js"),
    import("../lib/session-tree.js"),
    import("../lib/state-bus.js"),
    import("../lib/sessions.js"),
  ]);
  const deletedItem = plan.records[plan.index];
  const records = plan.records;
  records.splice(plan.index, 1);
  sessions.saveSessions(records);
  tree.invalidateSessionTree();
  const mcodeSid = deletedItem.mcodeSessionId;
  let mcodeDbDel = null;
  if (mcodeSid) {
    try {
      acp.shutdownMcodeAcpSingleton();
    } catch {}
    acp.dropMcodeSessionFromCache(mcodeSid);
    // M4-3a: async now (the engine call is), and the only async step in
    // this function. Everything ordered around it — the store splice above,
    // the cache drop above, the fan-out below — is unchanged, because the
    // order, not the speed, is what this endpoint guarantees.
    mcodeDbDel = await deleter.deleteSessionThroughEngine(mcodeSid, {
      MCODE_RUNTIME_DB: config.MCODE_RUNTIME_DB,
    });
    // The pre-facade route logged this from inside the `if (mcodeSid)`
    // block, so the engine-mirror line only appears for records that
    // actually have one. Kept here, next to the call it describes, so
    // the operator log and the code that produced it stay together.
    console.log(
      `[delete] mcode db delete sid=${mcodeSid.substring(0, 12)}… ok=${mcodeDbDel.ok}` +
        (mcodeDbDel.ok
          ? ` log=[${(mcodeDbDel.log || []).join(",")}]`
          : ` reason=${mcodeDbDel.reason || "-"} error=${mcodeDbDel.error || "-"}`),
    );
  }
  const touchedCids = [];
  for (const [c, ccs] of bus.clients) {
    if (!clientMatchesDeletedSession(ccs, deletedItem, plan.id)) continue;
    applyDeletedSessionToClientState(ccs);
    sessions.resetContext(ccs);
    touchedCids.push(c);
  }
  // Exactly the pre-facade fallback, including the `undefined` it would
  // push when the caller supplied no cid: the point is that the
  // requesting tab ALWAYS gets a state push, so it cannot be left
  // rendering a session the server has already deleted.
  if (touchedCids.length === 0) touchedCids.push(cid);
  for (const c of touchedCids) bus.pushStateFor(c);
  return {
    deletedItem,
    records,
    mcodeDbDel,
    touchedCids,
    payload: {
      ok: true,
      deleted: plan.id,
      matchKind: plan.matchKind,
      dryRun: false,
      remaining: records.length,
      mcodeDbDel,
    },
  };
}

/**
 * #4 — the rename write.
 *
 * Everything this endpoint persists lands in webui's own session store.
 * The single engine touch is `invalidateSessionTree()`, and it is there
 * because the sidebar tree reads titles out of the engine — the same
 * reason the pre-facade route had it. The engine's own title is NOT
 * written; see the `SESSION_WRITE_ENDPOINTS` row for why that makes the
 * capability declaration `null` rather than a guess.
 *
 * The `not_found` outcome is a value, not an exception: a bare `mvs_…`
 * id with no webui record gets an overlay record to carry the title
 * (the single-identity rule, same as the switch path), and anything
 * else is a 404 because the id is simply wrong. Returning which of the
 * three happened is what lets the route write the right status without
 * this module knowing what a status is.
 *
 * Validation of `id` and `title` is NOT done here. It is HTTP request
 * validation with three 400 bodies this module would then have to
 * reproduce byte for byte, and the route already owns the request.
 *
 * @param {object} options
 * @param {string} options.id     The record's webui uuid or `mvs_…` sid.
 * @param {string} options.title  New title; already trimmed and validated.
 * @param {string} [options.cid]  Requesting client id.
 * @param {string} [options.endpoint]  Endpoint key for the declaration
 *        check; defaults to `/api/sessions/rename`.
 * @param {string} [options.transport] Transport override.
 * @returns {Promise<{outcome: "ok"|"not_found", matchKind: string, from: string, to: string, item: object|null, payload: object|null, gate: object, transport: string}>}
 */
export async function applyEngineSessionRename(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/rename";
  const [sessions, config, tree, bus] = await Promise.all([
    import("../lib/sessions.js"),
    import("../lib/config.js"),
    import("../lib/session-tree.js"),
    import("../lib/state-bus.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertSessionWriteCapability(endpoint, transport);
  const id = options.id;
  const title = options.title;
  const all = sessions.loadSessions();
  const { index, matchKind: foundKind } = resolveSessionTarget(all, id);
  let item;
  let matchKind;
  if (index < 0) {
    if (!isMcodeSessionId(id)) {
      return {
        outcome: "not_found",
        matchKind: null,
        from: "",
        to: title,
        item: null,
        payload: { ok: false, error: "session not found" },
        gate,
        transport,
      };
    }
    // A bare mvs_ id with no webui shell gets one created to carry the
    // title. No workspace argument, and none was ever passed: stamping
    // the caller's current workspace onto someone else's record
    // attributes a workspace the session never ran in, and re-roots the
    // file tree on every later switch (webui-parity 63, defect F).
    item = sessions.ensureOverlayForMcodeSid(all, id);
    matchKind = "orphan_mcode";
  } else {
    item = all[index];
    matchKind = foundKind;
  }
  const from = item.title || "";
  item.title = title;
  item.titleCustom = true;
  item.updatedAt = Date.now();
  sessions.saveSessions(all);
  tree.invalidateSessionTree();
  let touchedCids = [];
  for (const [c, ccs] of bus.clients) {
    if (!clientMatchesRenamedSession(ccs, item)) continue;
    applyRenamedSessionToClientState(ccs, title);
    touchedCids.push(c);
  }
  if (touchedCids.length === 0) touchedCids.push(options.cid);
  for (const c of touchedCids) bus.pushStateFor(c);
  return {
    outcome: "ok",
    matchKind,
    from,
    to: title,
    item,
    payload: {
      ok: true,
      session: {
        id: item.id,
        mcodeSessionId: item.mcodeSessionId || null,
        title: item.title,
        titleCustom: true,
      },
    },
    gate,
    transport,
  };
}

/**
 * #6 — read the orphan sweep's target list.
 *
 * The file read stays here rather than in the route because the rule
 * and the bytes it reads are one decision: a sweep that read a different
 * file than the one whose rule it applies would be a bug waiting for a
 * config change. The BOM strip is the store's own on-disk convention
 * (written by an editor, not by webui) and is preserved exactly; a
 * parse failure answers `[]`, which the pre-facade code did too, and a
 * corrupt store must not turn a cleanup request into a 500.
 *
 * The response shape this backs is the batch's byte-for-byte red line,
 * so the payload is built HERE and never re-assembled in the route:
 * `{ok, dryRun, count, ids}` — four keys, in that order, for the
 * preview; `{ok, dryRun:false, deleted, ids}` for the no-op real path.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint]  Endpoint key for the declaration
 *        check; defaults to `/api/sessions/cleanup-orphans`.
 * @param {string} [options.transport] Transport override.
 * @returns {Promise<{ids: string[], payload: object, gate: object, transport: string}>}
 */
export async function readOrphanSessionWriteIds(options = {}) {
  const endpoint = options.endpoint || "POST /api/sessions/cleanup-orphans";
  const config = await import("../lib/config.js");
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertSessionWriteCapability(endpoint, transport);
  const dbPath = config.SESSIONS_DB;
  let records = [];
  if (existsSync(dbPath)) {
    try {
      let raw = readFileSync(dbPath, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records = parsed;
    } catch {
      records = [];
    }
  }
  const ids = selectOrphanSessionIds(records);
  return {
    ids,
    payload: { ok: true, dryRun: true, count: ids.length, ids },
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
//   1. M4-3a collected the write half of KNOWN DEBT 1: the 32-table
//      32-table row-destroying sweep is gone and the engine's
//      `deleteSession`
//      destroys the rows. The READ half stayed, and stays recorded
//      there — `engine/session-delete.js` still counts rows against a
//      hand-maintained table list, because the engine exposes no preview
//      form of the delete and `?dryRun=true` is part of this endpoint's
//      contract. Closing that needs a count surface on the engine itself.
//
//   2. #4 rename writes a WEBUI-side label only. The engine's own title
//      in `local_runtime_sessions` is untouched, while the sidebar tree
//      reads its titles from the engine. So for an engine-backed
//      session a rename can be visible in the wrapper list and not in
//      the tree. This is pre-existing behaviour and this batch did not
//      change it; closing it means deciding which store is
//      authoritative for a display title, which is a product call.
//
//   3. #7 does not detect "this session is running right now". A delete
//      of an in-flight session kills the ACP child out from under the
//      turn. That is the pre-facade behaviour and it is arguably the
//      correct one (the user asked), but "refuse to delete a running
//      session" is a defensible alternative and the choice is not this
//      batch's to make.
