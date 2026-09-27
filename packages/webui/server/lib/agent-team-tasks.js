// webui/server/lib/agent-team-tasks.js
// Read-only projections over `local_runtime_background_tasks` and
// `local_runtime_task_session_bindings`, used by the Agent Team wiring.
//
// Why this lives in its own module. The runtime db is read-only from
// webui's perspective (auth forces its location, `MINIMAX_DATA_DIR` does
// not relocate it; see .tickets/webui-parity/06-agent-team-panel.md R8).
// Every helper here opens a fresh handle with `{ readonly: true,
// fileMustExist: true }` and closes it in a `finally` so a long-lived
// process never leaks a file descriptor across the mavis restart that
// happens whenever the user upgrades the engine.
//
// `projectTaskStatus` (the only function that returns a string the UI
// reads) deliberately calls into `agent-team-status.js`. Nothing in this
// module may pass a raw db string to a wire payload — that is the rule
// that pins the vocabulary and keeps future contributors from re-opening
// the leak this slice 06 closed.

import { existsSync } from "node:fs";
import path from "node:path";

import { getMcodeBetterSqlite3 } from "./sqlite-resolver.js";
import { projectTaskStatus, AGENT_TEAM_STATUS } from "./agent-team-status.js";

const RESULT_PROBE_LIMIT = 50;

// `MCODE_RUNTIME_DB` is read FRESH on every helper call (not bound at
// import time) so the test harness can swap the db path via
// `process.env.MCODE_RUNTIME_DB` without reloading config.js. This is
// the same lazy pattern sqlite-resolver.js already uses internally for
// the binding path — the resolver caches the module export, but every
// helper here opens a fresh handle against the current env, so a test
// can override MCODE_RUNTIME_DB and a process restart picks it up.
function readRuntimeDbPath() {
  return process.env.MCODE_RUNTIME_DB || "";
}

/**
 * Open a fresh read-only handle to the runtime db.
 *
 * Returns `null` (not throw) on any failure: the caller is the sidebar
 * poll, and a missing / locked db is a normal state the UI must survive
 * — not a server-side error worth a 500.
 */
function openRuntimeDb() {
  const dbPath = readRuntimeDbPath();
  if (!dbPath || !existsSync(dbPath)) return null;
  const Db = getMcodeBetterSqlite3();
  if (!Db) return null;
  try {
    return new Db(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/**
 * Look up the latest `local_runtime_background_tasks` row whose
 * `kind = 'subagent'` AND whose `record_json.toolCallId = toolCallId`.
 *
 * The runtime stamps the `toolCallId` of the parent session's `→ task`
 * tool call on every subagent row it owns, so this lookup is what the
 * running badge on the parent's tool line polls against.
 *
 * @param {string} toolCallId
 * @returns {null | { taskId: string, status: string, agentName: string|null, childSessionId: string|null }}
 */
export function findSubagentTaskByToolCallId(toolCallId) {
  if (!toolCallId) return null;
  const db = openRuntimeDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT task_id, status,
                json_extract(record_json, '$.toolCallId') AS tool_call_id,
                json_extract(record_json, '$.metadata.agentName') AS agent_name,
                json_extract(record_json, '$.metadata.childSessionId') AS child_session_id
           FROM local_runtime_background_tasks
          WHERE kind = 'subagent'
            AND json_extract(record_json, '$.toolCallId') = ?
          ORDER BY created_at_ms DESC
          LIMIT 1`,
      )
      .get(toolCallId);
    if (!row) return null;
    return {
      taskId: row.task_id,
      status: projectTaskStatus(row.status),
      agentName: row.agent_name ?? null,
      childSessionId: row.child_session_id ?? null,
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * True iff the runtime db has ANY `local_runtime_background_tasks` row
 * with `kind = 'subagent'` for this `toolCallId`. Cheaper than the
 * full projection above — used to detect the moment a subagent is born
 * (the SSE `session-tree-changed` trigger).
 */
export function hasSubagentTaskByToolCallId(toolCallId) {
  if (!toolCallId) return false;
  const db = openRuntimeDb();
  if (!db) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok
           FROM local_runtime_background_tasks
          WHERE kind = 'subagent'
            AND json_extract(record_json, '$.toolCallId') = ?
          LIMIT 1`,
      )
      .get(toolCallId);
    return Boolean(row && row.ok);
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * Subagent tasks owned by `parentSessionId`, regardless of which turn they
 * landed on.
 *
 * Used by the tree-refresh path to confirm a new subagent row actually
 * belongs to a parent the user can see (the `parent_session_id` on the
 * new `local_runtime_sessions` row is the source of truth — but the task
 * row's `metadata.parentSessionId` is a redundant cross-check, useful
 * for sessions whose parent pointer races the db write).
 *
 * @returns {Array<{ toolCallId: string, status: string, agentName: string|null, childSessionId: string|null, createdAtMs: number }>}
 */
export function listSubagentTasksByParentSession(parentSessionId, { limit = 32 } = {}) {
  if (!parentSessionId) return [];
  const db = openRuntimeDb();
  if (!db) return [];
  const cap = Math.max(1, Math.min(limit, RESULT_PROBE_LIMIT));
  try {
    const rows = db
      .prepare(
        `SELECT task_id, status, created_at_ms,
                json_extract(record_json, '$.toolCallId') AS tool_call_id,
                json_extract(record_json, '$.metadata.agentName') AS agent_name,
                json_extract(record_json, '$.metadata.childSessionId') AS child_session_id
           FROM local_runtime_background_tasks
          WHERE kind = 'subagent'
            AND owner_session_id = ?
          ORDER BY created_at_ms DESC
          LIMIT ?`,
      )
      .all(parentSessionId, cap);
    return rows.map((row) => ({
      taskId: row.task_id,
      status: projectTaskStatus(row.status),
      toolCallId: row.tool_call_id ?? null,
      agentName: row.agent_name ?? null,
      childSessionId: row.child_session_id ?? null,
      createdAtMs: Number(row.created_at_ms) || 0,
    }));
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * Probe the db for newly-spawned subagent sessions a given parent has not
 * yet been told about. Returns the toolCallId ↔ childSessionId pairs so
 * the SSE `session-tree-changed` trigger can attach the jump reference.
 *
 * Compared against the in-memory `recentSubagents` map in `state-bus.js`,
 * which tracks what the client already knows. The projection here is
 * projection-only: callers merge the diff.
 */
export function diffSubagentsByParentSession(parentSessionId, knownToolCallIds) {
  const known = knownToolCallIds instanceof Set ? knownToolCallIds : new Set();
  if (!parentSessionId) return [];
  const tasks = listSubagentTasksByParentSession(parentSessionId, { limit: 64 });
  return tasks.filter((t) => t.toolCallId && !known.has(t.toolCallId));
}

// re-export the status vocabulary so a caller that imports this module
// for the db helpers does not have to chase a second import.
export { AGENT_TEAM_STATUS };

// CommonJS interop: some test runners prefer `default`. Keep the named
// exports authoritative.
export default {
  findSubagentTaskByToolCallId,
  hasSubagentTaskByToolCallId,
  listSubagentTasksByParentSession,
  diffSubagentsByParentSession,
  AGENT_TEAM_STATUS,
};
