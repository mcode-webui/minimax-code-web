// webui/server/engine/usage-reads.js
//
// Migration step M3, batch B3: the usage family (用量族) — the four
// endpoints that answer "how much has this cost, and when will it run
// out":
//
//   #15  POST /api/usage          — plan quota (5h / weekly) read
//   #16  POST /api/usage-trigger  — the same read, recorded as a sample
//   #17  GET  /api/usage-real     — real per-session token usage
//   #19  GET  /api/usage/forecast — quota-exhaustion prediction
//
// What this file is for. Three of these four numbers decide what a user
// does next — refresh, switch model, stop working — and each of them is a
// DERIVED quantity, not a counter. #15/#16 re-derive the plan windows out
// of the engine's account projection. #17 re-derives `contextUsed` out of
// three separate token totals. #19 re-derives an exhaustion time out of a
// least-squares fit. A refactor that "cleans up" one of those formulas
// changes what the user sees and reports nothing, which is the failure
// mode this batch is gated on. So the derivations live HERE, once, named,
// and tested on their inputs — the route only assembles JSON.
//
// What this file deliberately does NOT do:
//
//   - It does not re-read the database. `lib/mavis-usage.js` owns the SQL,
//     the `node:sqlite` / `sqlite3`-spawn dual path and the NULL-to-zero
//     coercion; `lib/usage.js` owns the quota-window copy into `cs.usage`;
//     `lib/quota-forecast.js` owns the NDJSON history and the least-squares
//     fit. A second reader over `local_runtime_token_usage` would be a
//     second answer to "what did this session cost".
//   - It does not construct a host. #17's data currently comes from the
//     engine's own SQLite file, not from a live `CliService` — see the
//     `getSessionUsage` note below for why the provider call is deferred,
//     and for what would have to be true before it is not.
//   - It does not widen the engine's own degradation. `getMavisTokenUsage`
//     returns `null` for "no such session / no db / no rows", and the route
//     turns that into `{ok:true, found:false, …}` with HTTP 200. That
//     answer is the endpoint's long-standing contract and it is a
//     different question from "may this provider report usage at all".
//
// The `getSessionUsage` question, stated once because it is the batch's
// most load-bearing decision. The v2 provider declares `usageStats: full`,
// and `CliService#getSessionUsage` is a real method that reads the SAME
// `local_runtime_token_usage` table this endpoint already reads. Routing
// through it anyway today would be a behaviour change dressed as a
// refactor, for three measured reasons:
//
//   1. It only exists under the `runtime` transport. The catalogue host is
//      booted by `acp-client.js#transportWantsCatalogue()`, which is
//      `MCODE_WEBUI_TRANSPORT === "runtime"`. The DEFAULT transport is
//      `acp` (`lib/config.js`), and under it there is no `CliService` to
//      call — so the switch would take the endpoint from "always answers"
//      to "answers on one opt-in transport".
//   2. Its shape is not this endpoint's shape. `getSessionUsage` answers
//      `{summary, rows: UsageView[]}`; the endpoint answers a per-column
//      aggregate plus `rows` as a COUNT. Rebuilding the aggregate from
//      `rows` would re-derive `totalReasoning` and `contextUsed` from a
//      different starting point — exactly the silent numeric drift this
//      batch forbids.
//   3. It would put the v2 TypeScript dependency tree on the answer path
//      of an endpoint that currently needs nothing from it (the M1 lesson).
//
// So the declaration names the provider method the endpoint DEPENDS ON —
// which is what a declaration is for — and the read keeps using the file
// the provider itself would read. M4 is where the two are allowed to meet.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It therefore statically imports
// nothing heavier than `capabilities.js` and `index.js` (both pure
// declaration modules); `lib/usage.js`, `lib/mavis-usage.js`,
// `lib/quota-forecast.js` and `lib/config.js` are reached through
// `await import()` inside the functions. That split is the M1 lesson —
// putting the `@mavis/*` tree on the boot path once cost 209ms → 2700ms of
// server start and broke the integration tests' 3s window.
//
// Provider selection is M4's job, same as B1 and B2: `providerByTransport()`
// maps a transport to a REGISTERED provider id; today only `runtime` has
// one, so under the default `acp` transport the gate reports
// `gate: "unregistered-transport"` instead of inventing one.

// `node:fs` is a builtin, not a project dependency: the boot-path promise
// below is about not dragging lib/ or @mavis/* trees in, and this costs
// nothing. It is here for one caller — #17's `dbExists`, which the route
// used to compute itself from a path constant it imported at module scope.
import { existsSync } from "node:fs";

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport` and
 * `session-tree-reads.js#providerByTransport`, which this mirrors rather
 * than merges: the four families have separate read contracts and a shared
 * table would force one of them to inherit another's policy.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its temporal
 * dead zone on a cold `import("./engine/index.js")`. Every consumer of the
 * table is a function anyway.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * The declaration each endpoint of this family needs, and the sub-item it
 * needs from that capability.
 *
 *   - #15 / #16 are `authCredentials` / `getAccountStatus`. The plan tier
 *     and both window percentages come from the engine's account
 *     projection, and the declaration names that method explicitly ("the
 *     engine holds the credential, so it is the only side that may call
 *     MiniMax's quota endpoint" — see `lib/usage.js`). A `partial` that
 *     dropped exactly `getAccountStatus` would answer 501 naming it rather
 *     than a generic refusal.
 *   - #17 is `usageStats` / `getSessionUsage` — the same pair the v2
 *     declaration enumerates under `usageStats`. See the header for why
 *     the read does not yet call that method.
 *   - #19 is `null`, and this is the one row a reader will double-take.
 *     The forecast reads `~/.mcode-webui/usage-history.ndjson`, a file
 *     webui itself appends to; it calls no engine surface at all. The
 *     numbers in it ORIGINATED in the engine, but a read that touches no
 *     engine surface must not be gated on an engine capability — that is
 *     the same lie B1 declined for `/api/health`, and gating it hard would
 *     remove a working endpoint in response to a declaration about
 *     something it does not depend on. The precedent for a soft family
 *     that DOES cross the seam is B2's export enrichment
 *     (`_meta.mcode_unavailable`); #19 needs none of that, because there is
 *     no enrichment to lose.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string}|null>>}
 */
export const USAGE_READ_ENDPOINTS = Object.freeze({
  "POST /api/usage": { capability: "authCredentials", subItem: "getAccountStatus" },
  "POST /api/usage-trigger": { capability: "authCredentials", subItem: "getAccountStatus" },
  "GET /api/usage-real": { capability: "usageStats", subItem: "getSessionUsage" },
  "GET /api/usage/forecast": null,
});

/**
 * Resolve the provider that answers usage reads on `transport`, or `null`
 * when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveUsageReadProvider(transport) {
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
 * @param {string} endpoint  A key of USAGE_READ_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null}}
 */
export function assertUsageReadCapability(endpoint, transport) {
  const need = USAGE_READ_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation — a plain Error so the
    // HTTP layer never answers 501 for a typo in webui's own code.
    const err = new Error(
      `assertUsageReadCapability: "${endpoint}" is not part of the usage family ` +
        `(known: ${Object.keys(USAGE_READ_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_usage_read_endpoint";
    throw err;
  }
  const provider = resolveUsageReadProvider(transport);
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
// The derivations. Pure functions, exported, and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * The `contextUsed` figure `GET /api/usage-real` reports.
 *
 * CUMULATIVE input + output + reasoning, and deliberately NOT the
 * per-turn figure. The two coexist in this repository and confusing them
 * is the single most likely way for this endpoint to start lying:
 *
 *   - `lib/mavis-usage.js#_buildUsageResult` publishes
 *     `lastTurnContextTokens` (last input + output + reasoning) and the
 *     chat flow stores it as `cs.context.tokens` — the CONTEXT BAR. One
 *     turn's worth, always ≤ the model's context limit.
 *   - `GET /api/usage-real` reports the session's CUMULATIVE spend
 *     (`v0.5.bx-10` fix: "context 实际是 input + output + reasoning"),
 *     which is why a 13-turn session can show 566k there. That is what
 *     the number has always meant on this endpoint and the frontend reads
 *     it as such.
 *
 * `cacheRead` / `cacheWrite` are excluded: they are a SUBSET of `input`
 * (counted again by the engine inside the prompt), so adding them
 * double-counts. `totalCacheWrite` is excluded for the same reason plus
 * the fact that it is not part of the context window at all.
 *
 * Written as one expression, in the order the endpoint has always summed,
 * over the SAME three fields the endpoint has always summed. That is
 * deliberate: every field here arrives already coerced to a number by
 * `_buildUsageResult` (`Number(x) || 0`), so no rounding point is
 * introduced, and a `null` from a future provider coerces exactly the way
 * the pre-facade expression coerced it. `test/lib/engine/usage-reads.test.js`
 * pins the inputs, not just this number.
 *
 * @param {object} usage A `getMavisTokenUsage` result.
 * @returns {number}
 */
export function contextUsedTokens(usage) {
  return usage.totalInput + usage.totalOutput + usage.totalReasoning;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Where each read's bytes actually came from. Three distinct producers,
 * named rather than assumed:
 *
 *   - `"account-status"` — the engine's `mcode/account/status` extension
 *     method, via `lib/mcode-rpc.js#getAccountStatus`. The same answer
 *     `quotaSnapshot` has always labelled `source: "acp"` in its own
 *     payload; the facade names the producer rather than the wire.
 *   - `"runtime-db"` — the engine's own `local_runtime_token_usage` table
 *     in its runtime sqlite, via `lib/mavis-usage.js`. Same vocabulary as
 *     B2's session tree: not a transport-switched surface.
 *   - `"history-file"` — webui's OWN `usage-history.ndjson`. The forecast
 *     read touches no engine surface, which is why its declaration row is
 *     `null`; this value keeps that honest at the call site.
 *
 * @typedef {"account-status" | "runtime-db" | "history-file"} UsageReadSource
 */

/**
 * #15 / #16 — the plan-quota read.
 *
 * `runUsageQuery` is the whole contract and is forwarded verbatim: it
 * copies the engine's projection into `cs.usage`, appends at most one
 * NDJSON history sample when `record` is on, pushes state, and returns the
 * popover payload. The route writes that payload as the response body
 * byte-for-byte, including its `ok:false` / `error` shape for an engine
 * that could not be reached — the request itself succeeded, so the status
 * stays 200.
 *
 * `record` is the difference between reading and measuring, and it is NOT
 * defaulted here: `lib/usage.js` owns that default (`true`, the
 * historical "a read is also a measurement" behaviour). The route passes
 * the client's explicit `record !== false` through unchanged.
 *
 * @param {object} options
 * @param {object} options.cs       The webui client state `cs.usage` is written into.
 * @param {string} options.cid      Client id, for the state push.
 * @param {boolean} [options.record] Append a forecast sample; see above.
 * @param {string} [options.endpoint] Endpoint key for the declaration
 *        check; defaults to `/api/usage`.
 * @param {string} [options.transport] Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`. Exists so tests can exercise both
 *        the `runtime` and the unregistered `acp` branch without mutating
 *        process env.
 * @returns {Promise<{payload: object, source: UsageReadSource, gate: object, transport: string}>}
 */
export async function readEngineAccountQuota(options = {}) {
  const endpoint = options.endpoint || "POST /api/usage";
  const usage = await import("../lib/usage.js");
  const config = await import("../lib/config.js");
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertUsageReadCapability(endpoint, transport);
  const payload = await usage.runUsageQuery(options.cs, options.cid, {
    record: options.record !== false,
  });
  return { payload, source: "account-status", gate, transport };
}

/**
 * #17 — the real per-session token usage.
 *
 * `usage` is `getMavisTokenUsage`'s own object, forwarded field for
 * field: `rows`, the five totals, `firstTs`, `lastTs`, and the per-turn
 * and cache-hit figures the chat flow also consumes. The facade adds
 * exactly one derived number, `contextUsed` (see `contextUsedTokens`), and
 * nothing else — in particular it does not re-derive `totalReasoning`,
 * which is the database's own `SUM(reasoning_tokens)` and has exactly one
 * correct source.
 *
 * `found:false` carries the same two facts the endpoint has always
 * reported for "no session id yet / no such session": which database it
 * looked in, and whether that database exists. `dbExists` is the
 * `existsSync` the route used to do itself, moved behind the lazy
 * `lib/config.js` boundary so `routes/usage.js` no longer names a path
 * constant at module scope.
 *
 * @param {object} [options]
 * @param {string|null} [options.mcodeSessionId] The `mvs_…` id to read.
 * @param {string} [options.endpoint]   Endpoint key for the declaration
 *        check; defaults to `/api/usage-real`.
 * @param {string} [options.transport]  Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @returns {Promise<{mcodeSessionId: string, found: boolean, usage: object|null, contextUsed: number|null, model: string|null, dbPath: string, dbExists: boolean, source: UsageReadSource, gate: object, transport: string}>}
 */
export async function readEngineSessionUsage(options = {}) {
  const endpoint = options.endpoint || "GET /api/usage-real";
  const [mavis, config] = await Promise.all([
    import("../lib/mavis-usage.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertUsageReadCapability(endpoint, transport);
  const mcodeSessionId = options.mcodeSessionId || "";
  const dbPath = config.MAVIS_DB_PATH;
  const dbExists = existsSync(dbPath);
  const usage = mcodeSessionId ? await mavis.getMavisTokenUsage(mcodeSessionId) : null;
  if (!usage) {
    return {
      mcodeSessionId,
      found: false,
      usage: null,
      contextUsed: null,
      model: null,
      dbPath,
      dbExists,
      source: "runtime-db",
      gate,
      transport,
    };
  }
  // Best-effort and in that order: the endpoint has always answered even
  // when the model lookup fails, and `getMavisTokenUsageModel` returns
  // `null` for its own reasons (no db, no row, a `model` column that is
  // NULL or empty). `(m && m.model) || null` is the endpoint's own
  // fallback, kept verbatim.
  const model = await mavis.getMavisTokenUsageModel(mcodeSessionId).catch(() => null);
  return {
    mcodeSessionId,
    found: true,
    usage,
    contextUsed: contextUsedTokens(usage),
    model: (model && model.model) || null,
    dbPath,
    dbExists,
    source: "runtime-db",
    gate,
    transport,
  };
}

/**
 * #19 — the quota-exhaustion forecast.
 *
 * `readHistory` and `forecastExhaustion` are forwarded verbatim, which is
 * what keeps the SEQUENCE continuous: the forecast for a given history
 * prefix is a pure function of that prefix, and a refactor that re-read,
 * re-filtered, re-sorted or re-sampled the history would shift every
 * point of the curve without changing any single call's shape.
 * `test/lib/engine/usage-reads.test.js#forecast sequence` pins the prefix
 * series against the pre-refactor computation.
 *
 * The `try/catch` around `readHistory` is the endpoint's own belt-and-
 * braces guard (the module already swallows FS errors; the catch is so a
 * buggy extension can never break the endpoint) and it MOVES here with
 * the read, because the read is what can fail. On failure the history is
 * `[]`, and `forecastExhaustion([])` answers `reason: "no_history"` —
 * byte-identical to the pre-facade body, which the UI renders as
 * "collecting data…".
 *
 * @param {object} [options]
 * @param {string} [options.endpoint]  Endpoint key for the declaration
 *        check; defaults to `/api/usage/forecast`.
 * @param {string} [options.transport] Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @param {object} [options.forecastOptions] Forwarded to
 *        `forecastExhaustion` (`minSamples`, `nowMs`); the endpoint passes
 *        neither today, and the defaults must stay the module's.
 * @returns {Promise<{forecast: object, historyLength: number, source: UsageReadSource, gate: object, transport: string}>}
 */
export async function readEngineQuotaForecast(options = {}) {
  const endpoint = options.endpoint || "GET /api/usage/forecast";
  const [quota, config] = await Promise.all([
    import("../lib/quota-forecast.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertUsageReadCapability(endpoint, transport);
  let history = [];
  try {
    history = quota.readHistory();
  } catch {
    history = [];
  }
  return {
    forecast: quota.forecastExhaustion(history, options.forecastOptions || {}),
    historyLength: history.length,
    source: "history-file",
    gate,
    transport,
  };
}
