// webui/server/engine/session-delete.js
//
// The session-delete DATA PLANE (迁移步骤 M4-3a): where the rows actually
// go when webui deletes a session.
//
// What this module replaced. Until M4-3a the destructive half of
// `DELETE /api/sessions/:id` lived in `lib/mcode-session-delete.js`, which
// opened the runtime database directly and issued `DELETE FROM <table> WHERE
// session_id = ?` against a hand-curated list of 32 `local_runtime_*` tables
// inside one explicit transaction. That was the F-7 design's technical debt
// item 1 and the M3-B5 plan's "delete" annotation. The cost was not the SQL,
// it was ownership: webui had learned the engine's table layout by hand, and
// a schema the list did not know about would have been left behind as orphan
// rows with no signal that anything was missing.
//
// What it is now. The destructive step is the ENGINE's own
// `deleteSession`, reached through the same process-local catalogue host the
// rest of the facade uses (`getEngineCatalogueHost()` → `host.cliService`,
// the surface `local-runtime-v2.capabilities.js` declares `sessionCrud:
// full` over, whose implementation is
// local-runtime-v2/service/session-system/sessions/lifecycle/deletion-service.ts).
// webui no longer names a single engine table for the purpose of destroying
// data: it names a method.
//
// The read-only half is deliberately KEPT, and the reason is a fact, not
// caution. The engine exposes NO dry-run or preview form of the delete —
// `deleteSession(ctx, {id})` takes no options and returns no per-table
// counts. The `?dryRun=true` contract of #7 and #6 is therefore answered by
// the readonly per-table COUNT below, which is the same 32-table list the
// retired DELETE loop iterated and the same shape it returned. webui still
// READS a table layout it maintains by hand; it no longer WRITES one. That
// asymmetry is the whole of what this batch collected, and it is recorded
// again as KNOWN DEBT 1 at the bottom.
//
// The real delete takes its counts from the SAME readonly pass, taken
// immediately BEFORE the engine call, so `log` and `totalRowsDeleted` — and
// therefore the `rowsAffected` / `mcodeRowsAffected` fields the HTTP layer
// derives from them — carry the same values they always did. This is the
// reason the preview is not a separate optional feature here: dropping it
// would silently turn both counters into zero, which is a behaviour change
// dressed as a refactor.
//
// Audit ordering is unchanged and is the third thing this module owns: the
// `session.delete.intent` line lands BEFORE the destructive step, the
// `session.delete` outcome line AFTER it, and either audit write failing is
// fail-closed (`{ok:false, reason:"audit_write_failed"}`) rather than
// swallowed. A rolled-back or refused delete leaves no outcome event, exactly
// as before.
//
// Boot-path weight. `engine/session-writes.js` reaches this module through
// `await import()` inside its functions, exactly as it reached the retired
// one; this module adds no top-level cost the old one did not already have
// (`node:fs`, `lib/events.js`, `lib/sqlite-resolver.js`).
//
// Injection seams, all optional and all defaulted to the production
// collaborators: `getDb` (better-sqlite3 constructor, as before),
// `getHost` (the catalogue host, defaulting to `getEngineCatalogueHost`),
// `appendEvent` (the audit append, defaulting to `lib/events.js#append`).
// They exist so a test can drive a real delete without booting a runtime,
// which is the only way the engine branch is testable at all.

import { existsSync } from "node:fs";
import { append as _defaultAppend } from "../lib/events.js";
import { getMcodeBetterSqlite3 } from "../lib/sqlite-resolver.js";

// The tables a session owns, for READ-ONLY preview purposes only. Kept in
// the same order and with the same names the retired DELETE loop used, so a
// preview report is comparable with the pre-M4-3a ones line for line.
//
// `ON DELETE CASCADE` needs `PRAGMA foreign_keys=ON` (off by default in
// SQLite), which is why the retired loop hand-deleted rather than relying on
// the schema. That reasoning is now history — the engine owns the cascade —
// but the LIST is still the map of what a session can own, and a session's
// usage ledger (`local_runtime_token_usage`) is one of them, so the preview
// must keep naming it.
//
// `questionnaire_requests` has no `local_runtime_` prefix and no settled
// ownership, so it was never in this list and is still not.
export const SESSION_DELETE_PREVIEW_TABLES = [
  // — 会话本体与索引 —
  "local_runtime_sessions",
  "local_runtime_sessions_fts", // external content FTS5 (会话标题搜索)
  "local_runtime_session_fts_keys",
  "local_runtime_session_locks",
  "local_runtime_session_projection_watermarks",
  "local_runtime_session_asset_index_state",
  "local_runtime_session_agent_state",
  "local_runtime_workspace_indexing_sessions",
  "local_runtime_workspace_indexing_revisions",
  "local_runtime_session_assets",
  // — 消息本体 —
  "local_runtime_messages",
  "local_runtime_message_rows",
  "local_runtime_message_row_migrations",
  "local_runtime_pi_history_rows",
  "local_runtime_pi_history_row_migrations",
  "local_runtime_pi_history_file_migrations",
  // — turn / 队列 —
  "local_runtime_turn_ingress",
  "local_runtime_turn_ingress_client_requests",
  "local_runtime_turn_diffs",
  "local_runtime_turn_diff_journal",
  "local_runtime_turn_diff_rewind_operations",
  "local_runtime_queues",
  "local_runtime_queue_items",
  "local_runtime_queue_row_migrations",
  "local_runtime_queue_migration_quarantine",
  // — 用量与账目 —
  "local_runtime_token_usage",
  "local_runtime_ledger_watermarks",
  // — 关联实体 —
  "local_runtime_thread_goals",
  "local_runtime_cron_session_history",
  "local_runtime_v2_cron_runs",
  "local_runtime_file_api_uploads",
  "local_runtime_query_view_states",
];

// Per-table error CLASSIFICATION, carried over verbatim from the retired
// module because it is a statement about SQLITE, not about the engine. The
// original code caught every per-table error as if the table were merely
// absent and still returned ok:true — a lock conflict, prepare/run failure,
// schema anomaly, or IO error was indistinguishable from "mcode version
// without this table", so real failures reported success. Only a CONFIRMED
// missing table is skippable now; everything else surfaces as a failure so a
// preview never fakes success by silently undercounting.
function _sqliteErrorMessage(e) {
  return e && e.message ? String(e.message) : "";
}

// Confirmed missing table = (a) the error text is SQLite's "no such table"
// shape AND (b) the schema catalog read on THIS connection agrees the table
// truly does not exist. A "no such table" message while sqlite_schema still
// lists the table (torn state, shadow-table weirdness) is NOT confirmed →
// surfaces as a real error.
function _isConfirmedMissingTable(db, table, e) {
  if (!/^no such table:\s*\S+/i.test(_sqliteErrorMessage(e))) return false;
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(table);
    return !!row && row.c === 0;
  } catch {
    return false; // catalog unreadable → cannot confirm → real error
  }
}

// Confirmed unsupported schema = the error is SQLite's "no such column"
// shape naming the exact column the preview filters on (session_id), AND
// table_info() agrees the table exists but lacks that column. The list is
// curated for session_id-keyed tables, so a present-but-keyless table
// means this mcode version's schema is not one we know how to read —
// reported as a failure, never as a zero count.
function _isConfirmedUnsupportedSchema(db, table, e) {
  const m = /^no such column:\s*(\S+)/i.exec(_sqliteErrorMessage(e));
  if (!m) return false;
  const col = m[1].split(".").pop(); // strip db.table.col qualification
  if (col !== "session_id") return false;
  try {
    const rows = db.pragma(`table_info(${table})`);
    return (
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every((r) => !r || r.name !== "session_id")
    );
  } catch {
    return false;
  }
}

// Shared classifier for the preview loop. Verdicts: "absent" (confirmed
// missing table — benign skip), "unsupported_schema" (confirmed keyless
// table), "error" (lock / prepare / run / IO / anything else).
function _classifyTableError(db, table, e) {
  if (_isConfirmedMissingTable(db, table, e)) return "absent";
  if (_isConfirmedUnsupportedSchema(db, table, e)) return "unsupported_schema";
  return "error";
}

// Tagged error for the unsupported-schema verdict, so the outer catch reads
// .unsupportedSchema/.table to shape the failure return without
// string-matching the message again.
function _schemaError(table, e) {
  const err = new Error(
    `unsupported schema: table ${table} exists without a session_id column`,
  );
  if (e && e.code) err.code = e.code;
  err.table = table;
  err.unsupportedSchema = true;
  return err;
}

/**
 * Resolve the collaborators a delete needs, and reject the two inputs that
 * must be rejected BEFORE any of them is touched.
 *
 * The order matters and is the pre-M4-3a order: the sid shape first, then
 * the database file, then the native module. `mcode_db_not_found` must win
 * over `better_sqlite3_not_loaded` when both apply, because it is the more
 * specific answer.
 *
 * @param {string} sid
 * @param {object} options
 * @param {string} [options.MCODE_RUNTIME_DB]
 * @param {(() => object|null)} [options.getDb]
 * @returns {{failure: object}|{failure: null, Db: Function, dbPath: string}}
 */
function _resolveDeleteInputs(sid, options) {
  if (!/^mvs_[a-f0-9]{32}$/.test(sid)) {
    return { failure: { ok: false, reason: "not_mcode_sid" } };
  }
  const dbPath = options.MCODE_RUNTIME_DB;
  if (!dbPath || !existsSync(dbPath)) {
    return { failure: { ok: false, reason: "mcode_db_not_found" } };
  }
  const Db = options.getDb ? options.getDb() : getMcodeBetterSqlite3();
  if (!Db) {
    return { failure: { ok: false, reason: "better_sqlite3_not_loaded" } };
  }
  return { failure: null, Db, dbPath };
}

/**
 * The readonly per-table count, as the internal shape the real delete also
 * uses: which tables hold rows for this sid, how many in total, and how many
 * of the listed tables this mcode build simply does not have.
 *
 * @param {string} sid
 * @param {object} options  As `_resolveDeleteInputs`, plus a resolved `Db`.
 * @returns {{ok: true, log: string[], totalRows: number, tablesAbsent: number}|{ok: false, error: string, reason?: string, table?: string}}
 */
function _countSessionRows(sid, { Db, dbPath }) {
  let db;
  try {
    db = new Db(dbPath, { readonly: true });
    const log = [];
    let tablesAbsent = 0;
    for (const t of SESSION_DELETE_PREVIEW_TABLES) {
      try {
        const r = db
          .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE session_id = ?`)
          .get(sid);
        if (r && r.c > 0) log.push(`${t}:${r.c}`);
      } catch (e) {
        // Skip ONLY a confirmed missing table (mcode versions differ in
        // schema — absence is benign). Lock/prepare/run/schema/IO errors
        // rethrow → the outer catch reports a failure; a preview must not
        // fake success by silently undercounting.
        const verdict = _classifyTableError(db, t, e);
        if (verdict === "absent") {
          tablesAbsent += 1;
          continue;
        }
        throw verdict === "unsupported_schema" ? _schemaError(t, e) : e;
      }
    }
    db.close();
    return {
      ok: true,
      log,
      totalRows: log.reduce((s, e) => s + Number(e.split(":")[1]), 0),
      tablesAbsent,
    };
  } catch (e) {
    if (db) try { db.close(); } catch {}
    if (e && e.unsupportedSchema) {
      return {
        ok: false,
        reason: "unsupported_schema",
        table: e.table,
        error: e.message,
      };
    }
    return {
      ok: false,
      reason: "db_error",
      error: _sqliteErrorMessage(e) || String(e),
      code: e && e.code ? e.code : undefined,
    };
  }
}

/**
 * `?dryRun=true` — count what a delete WOULD remove, and change nothing.
 *
 * Satisfies mcode-plugin-guide red-lines.md §"写操作/破坏性操作": callers
 * (CLI / API) can preview before committing. The returned object has exactly
 * the four keys it has always had (`ok`, `dryRun`, `log`, `totalRows`) —
 * the internal `tablesAbsent` is NOT projected, because this object is
 * embedded in the HTTP response verbatim and a new key there is a wire
 * change, not an implementation detail.
 *
 * Dry-run previews are audited too, with `dryRun: true`, so an operator can
 * answer "who ran this preview yesterday?" from the event stream alone. A
 * failed audit write surfaces as a failure rather than being swallowed.
 *
 * @param {string} sid
 * @param {object} [options]
 * @param {string} [options.MCODE_RUNTIME_DB]
 * @param {(() => object|null)} [options.getDb]
 * @param {Function} [options.appendEvent]  Audit sink seam.
 * @returns {{ok: boolean, dryRun?: true, log?: string[], totalRows?: number, reason?: string, error?: string, table?: string}}
 */
export function previewSessionDeleteRows(sid, options = {}) {
  const appendEvent = options.appendEvent || _defaultAppend;
  const resolved = _resolveDeleteInputs(sid, options);
  if (resolved.failure) return resolved.failure;
  const count = _countSessionRows(sid, resolved);
  if (!count.ok) return count;
  try {
    appendEvent("session.delete", {
      target: sid,
      actor: "user",
      payload: {
        matchKind: "dryRun_db",
        dryRun: true,
        previewedRows: count.totalRows,
        tables: count.log.length,
      },
    });
  } catch (e) {
    return { ok: false, reason: "audit_write_failed", error: e.message };
  }
  return { ok: true, dryRun: true, log: count.log, totalRows: count.totalRows };
}

/**
 * The real delete. The rows go through the engine's own `deleteSession`;
 * webui contributes the audit chain, the counts, and the fail-closed
 * classification around it.
 *
 * The order is the mechanism and each step exists for a reason:
 *
 *   1. Validate the sid, the database file and the native module — the
 *      cheapest refusals first, and the most specific one first among them.
 *   2. Take the readonly count. It runs BEFORE the intent audit and before
 *      the engine call, so the counts reported afterwards are the counts
 *      that were true going in, and so a read failure aborts before any
 *      audit line claims an intent that will not be attempted.
 *   3. Write `session.delete.intent`. Before the destructive step, always.
 *   4. Ask the engine to delete. Any throw is classified and returned; it
 *      never escapes as an exception, because the HTTP layer's failure
 *      shape is a value.
 *   5. Write `session.delete` with the outcome. AFTER, so a refused delete
 *      leaves no outcome event, and fail-closed, so a lost outcome line is
 *      an operator-visible failure rather than a clean `ok:true`.
 *
 * `outcome` keeps the same two values it has always had: `deleted` (rows
 * were there and the engine removed them) and `already_absent` (the engine
 * found nothing to remove, which is a successful delete of something that
 * was already gone — the same answer the retired loop gave when no table
 * matched).
 *
 * @param {string} sid
 * @param {object} [options]
 * @param {string} [options.MCODE_RUNTIME_DB]
 * @param {(() => object|null)} [options.getDb]
 * @param {(() => Promise<object|null>)} [options.getHost]  Defaults to
 *        `getEngineCatalogueHost()`. The seam exists so a test can drive
 *        this path without booting a runtime.
 * @param {Function} [options.appendEvent]  Audit sink seam.
 * @returns {Promise<{ok: boolean, outcome?: string, log?: string[], totalRowsDeleted?: number, tablesAbsent?: number, reason?: string, error?: string, code?: string}>}
 */
export async function deleteSessionThroughEngine(sid, options = {}) {
  const appendEvent = options.appendEvent || _defaultAppend;
  const resolved = _resolveDeleteInputs(sid, options);
  if (resolved.failure) return resolved.failure;
  const count = _countSessionRows(sid, resolved);
  if (!count.ok) return count;

  // Write-ahead intent audit: the intent line must land BEFORE the engine
  // is asked to destroy anything. Failure → {ok:false} and the caller
  // aborts; the rows are untouched.
  try {
    appendEvent("session.delete.intent", {
      target: sid,
      actor: "user",
      payload: { matchKind: "db", dryRun: false },
    });
  } catch (e) {
    return { ok: false, reason: "audit_write_failed", error: e.message };
  }

  let engineHost;
  try {
    const getHost = options.getHost || (await _defaultGetHost());
    engineHost = await getHost();
  } catch (e) {
    return {
      ok: false,
      reason: "engine_host_unavailable",
      error: e && e.message ? e.message : String(e),
    };
  }
  if (!engineHost) {
    return {
      ok: false,
      reason: "engine_host_unavailable",
      error: "the engine catalogue host is not available",
    };
  }

  // The engine's own surface, in the order the rest of the facade prefers
  // it: the CliService method the `sessionCrud: full` declaration names
  // first, the v2 feature application second. Both take the same id, and
  // the second exists because a host that answered `turn-diff` through
  // `applications.session.diff` is a host whose delete may be reached the
  // same way.
  const engineCall = _resolveEngineDelete(engineHost, sid);
  if (!engineCall.ok) return engineCall;
  try {
    await engineCall.result;
  } catch (e) {
    return {
      ok: false,
      reason: "engine_delete_failed",
      error: e && e.message ? e.message : String(e),
      code: e && e.code ? e.code : undefined,
    };
  }

  const outcome = count.totalRows > 0 ? "deleted" : "already_absent";
  try {
    appendEvent("session.delete", {
      target: sid,
      actor: "user",
      payload: {
        matchKind: "db",
        dryRun: false,
        outcome,
        tablesAffected: count.log.length,
        tablesAbsent: count.tablesAbsent,
        totalRowsDeleted: count.totalRows,
      },
    });
  } catch (e) {
    return { ok: false, reason: "audit_write_failed", error: e.message };
  }
  return {
    ok: true,
    outcome,
    log: count.log,
    totalRowsDeleted: count.totalRows,
    tablesAbsent: count.tablesAbsent,
  };
}

// The default host getter, resolved lazily so this module keeps no
// dependency on `engine/host.js` at load time (a static import would put
// the facade's own index on the boot path of a module that only ever needs
// one function from it).
async function _defaultGetHost() {
  const host = await import("./host.js");
  return host.getEngineCatalogueHost;
}

/**
 * Pick the engine's delete entry point on a booted host, without calling
 * it. Returning the promise rather than the function lets the caller await
 * exactly one thing and keeps the "which surface" decision here, where it
 * is testable.
 *
 * @param {object} host
 * @param {string} sid
 * @returns {{ok: true, result: Promise<unknown>}|{ok: false, reason: string, error: string}}
 */
function _resolveEngineDelete(host, sid) {
  const cliService = host && host.cliService;
  if (cliService && typeof cliService.deleteSession === "function") {
    return { ok: true, result: Promise.resolve(cliService.deleteSession({ id: sid })) };
  }
  const lifecycle =
    host && host.applications && host.applications.session
      ? host.applications.session.lifecycle
      : null;
  if (lifecycle && typeof lifecycle.deleteSession === "function") {
    return { ok: true, result: Promise.resolve(lifecycle.deleteSession({}, { id: sid })) };
  }
  // A booted host with no delete on either surface is a contract drift, and
  // it is reported as the absence it is rather than as a successful
  // delete: the provider declared `sessionCrud` and the host cannot honour
  // it. M4-2 owns that declaration.
  return {
    ok: false,
    reason: "engine_delete_unavailable",
    error:
      "the booted engine host exposes no deleteSession on cliService or applications.session.lifecycle",
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. `SESSION_DELETE_PREVIEW_TABLES` is still a hand-maintained list of 32
//    engine table names, and webui still opens the engine's database to
//    read it. The WRITE half of that knowledge is gone — nothing in webui
//    destroys an engine row any more — but the read half remains, and it
//    is only as correct as the last schema audit. Closing it needs a
//    preview/count surface ON THE ENGINE (a `countSessionRows` beside
//    `deleteSession`), which is a local-runtime-v2 change and therefore
//    outside this batch. Until that exists, a table added to the engine
//    after this list was last audited is invisible to `?dryRun=true`.
//
// 2. The engine's delete is strictly BROADER than the retired 32-table
//    sweep: `deletion-service.ts` also removes canvas, diff,
//    communication, channel bindings, questionnaires, permissions, goals,
//    query-collapse state and pins. That is the correct owner deciding
//    what a session owns, and it is why this batch is a behaviour change
//    in scope even though the HTTP contract did not move — but it also
//    means webui can no longer report "which tables were touched" from
//    what it knows, only from the pre-delete count.
//
// 3. The delete now requires a booted process-local catalogue host, which
//    the pre-M4-3a path did not. The first delete after a cold start pays
//    the boot. It shares the singleton the plugin and turn-diff routes
//    already boot, so in practice the cost is paid once per process by
//    whichever of the three asks first — but a delete issued before
//    anything else has touched the engine is measurably slower than it was.
