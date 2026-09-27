// webui/server/lib/agent-team-detect.js
// Subagent detection — parse `<task_result session_id="...">` out of a
// tool output body and match it against the runtime db's subagent task
// rows so the parent's tool line can carry a jumpable subagent reference
// and the running badge.
//
// The runtime's parent stream does not emit a dedicated subagent event;
// per .tickets/webui-parity/06-agent-team-panel.md the only authoritative
// signal the webui has is the `<task_result ... session_id="mvs_…">`
// literal that lands inside the body of a `→ task` tool result. The
// session row in `local_runtime_sessions` and the task row in
// `local_runtime_background_tasks` both exist by the time the result
// arrives; this module is the bridge that records the toolCallId ↔
// childSessionId pair on the cid and surfaces the live task status for
// the running badge.
//
// Every function in this module is pure (no I/O) or read-only — the
// runtime db is open `readonly: true` and the cid state is mutated
// through the public helpers in lib/state-bus.js, never directly.

import { AGENT_TEAM_STATUS, projectTaskStatus } from "./agent-team-status.js";
import {
  findSubagentTaskByToolCallId,
  hasSubagentTaskByToolCallId,
} from "./agent-team-tasks.js";

// The literal the engine writes inside the parent stream's tool body.
// Captured by the ticket's R8 investigation; non-greedy match keeps the
// attribute parser from gobbling a second sibling `<task_result ...>`
// tag. `session_id` is the only attribute we care about today; if the
// engine grows more (parent_turn_id, agent_name, …) we extend the regex
// without rewriting the parser.
const TASK_RESULT_TAG = /<task_result\b[^>]*?\bsession_id=["']([^"']+)["'][^>]*>/i;

// Agent-name attribute, if the engine ever inlines it. Optional — the
// live task row is the primary source for `agentName`.
const TASK_RESULT_AGENT = /<task_result\b[^>]*?\bagent=["']([^"']+)["']/i;

/**
 * Pull the child session id (and optional agent hint) out of a tool
 * result body. Returns null when the body does not look like a
 * `<task_result>` payload.
 *
 * @param {string|undefined|null} body
 * @returns {{ sessionId: string, agentName: string|null } | null}
 */
export function parseTaskResult(body) {
  if (typeof body !== "string" || body.length === 0) return null;
  const sidMatch = TASK_RESULT_TAG.exec(body);
  if (!sidMatch) return null;
  const sessionId = (sidMatch[1] || "").trim();
  if (!sessionId) return null;
  const agentMatch = TASK_RESULT_AGENT.exec(body);
  return {
    sessionId,
    agentName: agentMatch ? (agentMatch[1] || "").trim() || null : null,
  };
}

/**
 * True when the tool name (or the body's `<task_result>` tag) indicates
 * the engine just spawned a subagent. The header name is the cheapest
 * signal we have — every `task` tool call the engine dispatches in the
 * parent stream becomes a subagent row, so the header name alone is
 * enough to start polling the runtime db for the live status.
 *
 * Tool-name variants observed in R8:
 *   - "task"            — the canonical name
 *   - "Task"            — capitalised by some renderers
 *   - "delegate" / "delegatetask" — used by older builds
 * The match is case-insensitive and tolerant of underscores.
 */
export function isSubagentDispatch(toolName, body) {
  if (typeof toolName === "string" && toolName.trim()) {
    const n = toolName.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (n === "task" || n === "delegate" || n === "delegatetask") return true;
  }
  // Header may not be present (e.g. the webui attached mid-stream and
  // the very first frame is the body). The body's tag is enough.
  if (typeof body === "string" && TASK_RESULT_TAG.test(body)) return true;
  return false;
}

/**
 * Resolve the live subagent task for a toolCallId WITHOUT recording
 * anything. Returns the projected status so the running badge can
 * render without a per-render db hit on the wire.
 *
 * Read-only: callers MUST NOT mutate the returned object.
 */
export function readSubagentStatusForToolCall(toolCallId) {
  return findSubagentTaskByToolCallId(toolCallId);
}

/** Detect the moment a subagent is born — read-only, no side effects. */
export function detectSubagentBirth(toolCallId) {
  return hasSubagentTaskByToolCallId(toolCallId);
}

/** Re-export the status vocabulary so consumers can `import { AGENT_TEAM_STATUS }` here. */
export { AGENT_TEAM_STATUS, projectTaskStatus };
