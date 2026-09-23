// webui/server/lib/mcode-session-delete.js
// Single responsibility: raw session-delete SQL over the 32
// local_runtime_* runtime tables. No resolver knowledge — that lives
// in sqlite-resolver.js, imported here ONLY so the public export can
// hand callers a db constructor when they don't inject one.

import { existsSync } from "node:fs";
// Append-only audit for mcode-side session deletes. The audit fires
// AFTER the SQL transaction succeeds (so a rolled-back delete has no
// event). dryRun previews are also audited (with dryRun:true) so an
// operator can answer "who ran this preview yesterday?" from the event
// stream alone. Static import is fine: events.js has no dep on this
// module, so no cycle exists. The lazy resolver pattern below is
// defensive against future refactors.
import { append as _eventsAppend } from "./events.js";
import { getMcodeBetterSqlite3 } from "./sqlite-resolver.js";

// 删 mcode session 涉及的所有关联表 (含 FTS5 external content + 各种 state 表)
//   ON DELETE CASCADE 需要 PRAGMA foreign_keys=ON 才生效 (SQLite 默认 OFF), 这里不用 cascade, 全手动删
// 覆盖面对齐真实 schema — 实测 ~/.minimax/v2/sqlite 里有 28 张 session_id 键控表,
//   旧清单只删 9 张, 会把 message_rows(消息本体)/token_usage/pi_history 等大量数据留成孤儿行。
//   现按 "local_runtime_* 前缀 + PRAGMA 确认有 session_id 列" 全量收录;
//   questionnaire_requests 无 local_runtime 前缀、归属不明, 暂不删 (缺失表由调用处 try/catch 跳过)。
export const MCODE_SESSION_DELETE_TABLES = [
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

// Per-table error CLASSIFICATION. The original code caught every
// per-table error as if the table were merely absent and still
// returned ok:true — a lock conflict, prepare/run failure, schema
// anomaly, or IO error was indistinguishable from "mcode version
// without this table", so real failures reported success. Only a
// CONFIRMED missing table is skippable now; everything else rethrows
// so better-sqlite3 rolls the transaction back and the caller gets
// {ok:false} with a classified reason.
function _sqliteErrorMessage(e) {
  return e && e.message ? String(e.message) : "";
}

// Confirmed missing table = (a) the error text is SQLite's
// "no such table" shape AND (b) the schema catalog read on THIS
// connection agrees the table truly does not exist. A "no such table"
// message while sqlite_schema still lists the table (torn state,
// shadow-table weirdness) is NOT confirmed → surfaces as a real error.
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
// shape naming the exact column our DELETE/SELECT filters on
// (session_id), AND table_info() agrees the table exists but lacks
// that column. The delete list is curated for session_id-keyed tables,
// so a present-but-keyless table means this mcode version's schema is
// not one we know how to delete from — reported as
// {ok:false, reason:"unsupported_schema"}, never as success.
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

// Shared per-table classifier for the dry-run (COUNT) and real-delete
// (DELETE) loops. Verdicts: "absent" (confirmed missing table — benign
// skip), "unsupported_schema" (confirmed keyless table — labelled
// abort), "error" (lock / prepare / run / IO / anything else — abort).
function _classifyTableError(db, table, e) {
  if (_isConfirmedMissingTable(db, table, e)) return "absent";
  if (_isConfirmedUnsupportedSchema(db, table, e)) return "unsupported_schema";
  return "error";
}

// Tagged error for the unsupported-schema verdict. The outer catch
// reads .unsupportedSchema/.table to shape the failure return without
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

export function deleteMcodeSessionFromDb(
  sid,
  { MCODE_RUNTIME_DB, dryRun = false, getDb } = {},
) {
  if (!/^mvs_[a-f0-9]{32}$/.test(sid))
    return { ok: false, reason: "not_mcode_sid" };
  // Check db path BEFORE loading better-sqlite3 so callers get the most
  // specific failure first (`mcode_db_not_found` must win over
  // `better_sqlite3_not_loaded` when both apply).
  if (!MCODE_RUNTIME_DB || !existsSync(MCODE_RUNTIME_DB))
    return { ok: false, reason: "mcode_db_not_found" };
  // getDb seam — tests inject () => null to exercise the not-loaded
  // gate deterministically, independent of which resolver tiers happen
  // to load on the host (the monorepo tier always does in this repo).
  const Db = getDb ? getDb() : getMcodeBetterSqlite3();
  if (!Db) return { ok: false, reason: "better_sqlite3_not_loaded" };

  // dry-run path: open readonly, count rows per table, do NOT modify.
  // Satisfies mcode-plugin-guide red-lines.md §"写操作/破坏性操作":
  // callers (CLI / API) can preview what would be deleted before committing.
  if (dryRun) {
    let db;
    try {
      db = new Db(MCODE_RUNTIME_DB, { readonly: true });
      const log = [];
      for (const t of MCODE_SESSION_DELETE_TABLES) {
        try {
          const r = db
            .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE session_id = ?`)
            .get(sid);
          if (r && r.c > 0) log.push(`${t}:${r.c}`);
        } catch (e) {
          // Skip ONLY a confirmed missing table (mcode versions differ
          // in schema — absence is benign). Lock/prepare/run/schema/IO
          // errors rethrow → the outer catch reports {ok:false}; a
          // preview must not fake success by silently undercounting.
          const verdict = _classifyTableError(db, t, e);
          if (verdict === "absent") continue;
          throw verdict === "unsupported_schema" ? _schemaError(t, e) : e;
        }
      }
      db.close();
      const totalRows = log.reduce((s, e) => s + Number(e.split(":")[1]), 0);
      // Dry-run previews are state-touching actions; record what would
      // have been deleted with dryRun:true so the audit distinguishes
      // "actually deleted" from "previewed". A failed preview audit
      // surfaces as {ok:false} instead of being swallowed.
      try {
        _eventsAppend("session.delete", {
          target: sid,
          actor: "user",
          payload: {
            matchKind: "dryRun_db",
            dryRun: true,
            previewedRows: totalRows,
            tables: log.length,
          },
        });
      } catch (e) {
        return { ok: false, reason: "audit_write_failed", error: e.message };
      }
      return { ok: true, dryRun: true, log, totalRows };
    } catch (e) {
      if (db) try { db.close(); } catch {}
      return { ok: false, error: e.message };
    }
  }

  let db;
  try {
    // Write-ahead intent audit: the intent line must land BEFORE the
    // transaction opens. Failure → {ok:false} and the caller aborts;
    // the db is untouched.
    try {
      _eventsAppend("session.delete.intent", {
        target: sid,
        actor: "user",
        payload: {
          matchKind: "db",
          dryRun: false,
        },
      });
    } catch (e) {
      return { ok: false, reason: "audit_write_failed", error: e.message };
    }
    db = new Db(MCODE_RUNTIME_DB, { readonly: false });
    db.pragma("busy_timeout = 5000"); // mcode 端可能在写, 最多等 5s
    const log = [];
    const tablesAbsent = [];
    // The delete runs as ONE explicit transaction — any non-absent
    // per-table error throws out of the tx body so better-sqlite3
    // issues ROLLBACK (partial deletes never commit) and the outer
    // catch shapes a classified failure return.
    const tx = db.transaction((sid) => {
      for (const t of MCODE_SESSION_DELETE_TABLES) {
        try {
          const r = db
            .prepare(`DELETE FROM ${t} WHERE session_id = ?`)
            .run(sid);
          if (r.changes > 0) log.push(`${t}:${r.changes}`);
        } catch (e) {
          // Skip ONLY a confirmed missing table (already-absent signal).
          // Lock conflicts (SQLITE_BUSY/LOCKED), prepare/run failures,
          // schema anomalies, IO errors — all rethrow → rollback →
          // {ok:false}.
          const verdict = _classifyTableError(db, t, e);
          if (verdict === "absent") {
            tablesAbsent.push(t);
            continue;
          }
          throw verdict === "unsupported_schema" ? _schemaError(t, e) : e;
        }
      }
    });
    tx(sid);
    db.close();
    // Real mcode-side delete. We log AFTER tx() succeeds (no event on
    // rollback). log.length is the number of tables that actually had
    // rows for this sid — useful for "did this delete touch anything?"
    // debugging. We do NOT log the rows themselves (privacy + volume).
    // Fail-closed: if the OUTCOME write fails we still report
    // {ok:false, reason:"audit_write_failed"} — the rows are gone but
    // the operator must see the audit gap, never a clean ok:true.
    const totalRowsDeleted = log.reduce(
      (s, e) => s + Number((e.split(":")[1] || "0")),
      0,
    );
    // Explicit outcome enumeration. Success is "deleted" (rows
    // removed) or "already_absent" (transaction committed, nothing
    // matched — whether the tables were absent or simply held no rows
    // for this sid). Anything else is {ok:false}.
    const outcome = totalRowsDeleted > 0 ? "deleted" : "already_absent";
    try {
      _eventsAppend("session.delete", {
        target: sid,
        actor: "user",
        payload: {
          matchKind: "db",
          dryRun: false,
          outcome,
          tablesAffected: log.length,
          tablesAbsent: tablesAbsent.length,
          totalRowsDeleted,
        },
      });
    } catch (e) {
      return { ok: false, reason: "audit_write_failed", error: e.message };
    }
    return {
      ok: true,
      outcome,
      log,
      totalRowsDeleted,
      tablesAbsent: tablesAbsent.length,
    };
  } catch (e) {
    if (db)
      try {
        db.close();
      } catch {}
    // tx body threw → better-sqlite3 already issued ROLLBACK (no
    // partial delete commits). Surface a classified failure.
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
      error: e && e.message ? e.message : String(e),
      code: e && e.code ? e.code : undefined,
    };
  }
}