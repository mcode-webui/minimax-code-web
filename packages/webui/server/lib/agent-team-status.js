// webui/server/lib/agent-team-status.js
// DB → UI status projection for the Agent Team panel.
//
// Why this module exists. The runtime db is the source of truth for the
// parent/child session graph, but its column vocabulary is **not** what the
// UI should render:
//
//   • `local_runtime_sessions.status` is intentionally narrow: it only records
//     `idle | interrupted | aborted | error`. The runtime does not currently
//     flip this column while a session is actively running a turn — it stays
//     `idle`. Treating that as "not running" is correct; treating it as the
//     whole picture is wrong.
//
//   • `local_runtime_background_tasks.status` records the *actual* run state
//     of a delegated subagent (`running | succeeded | failed | canceled`).
//     The session row does not, and projecting only the session column is
//     how a sidebar would render a busy subagent as "idle".
//
// The TUI exposes a richer vocabulary (`failed | waiting | running | queued |
// done | stopped`) on its own projection layer; we do not import that, but we
// adopt the same shape so the contract stays greppable. Every UI consumer
// (the agent-team section of the sidebar, the running badge on a parent's
// task tool line, the task-view modal) reads the projected vocabulary below
// rather than raw db strings.
//
// This module is the ONLY place that decides the mapping. Raw values from
// the db are never passed through to the wire. New status values the
// runtime might grow land here as a single guard clause, and tests pin the
// current behavior so a future contributor cannot silently change it.

/**
 * The shape the UI renders. Ordered to match the TUI vocabulary for
 * greppability; the order is NOT load-bearing for the UI but it does help
 * the test reader see the mapping at a glance.
 */
export const AGENT_TEAM_STATUS = Object.freeze({
  IDLE: "idle",
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting",
  DONE: "done",
  STOPPED: "stopped",
  FAILED: "failed",
});

const UI_STATUSES = new Set(Object.values(AGENT_TEAM_STATUS));

/**
 * Map a `local_runtime_sessions.status` value to the UI vocabulary.
 *
 * Real measured values from this machine's db (ticket 06 R8 复核):
 *   • `idle`         — the only state the engine writes for an active session
 *   • `interrupted`  — the engine aborted a turn mid-flight (user stop, crash)
 *   • `aborted`      — the engine aborted a turn cleanly (cancel)
 *   • `error`        — the turn ended on an unrecoverable error
 *
 * The session row does NOT carry `running` / `done` / `failed` / `queued`.
 * Those come from `local_runtime_background_tasks.status` (see
 * `projectTaskStatus`). When the runtime grows a richer vocabulary the new
 * values land here AND in the matching test.
 */
export function projectSessionStatus(rawStatus) {
  const s = typeof rawStatus === "string" ? rawStatus.trim() : "";
  if (s === "error") return AGENT_TEAM_STATUS.FAILED;
  if (s === "aborted") return AGENT_TEAM_STATUS.FAILED;
  if (s === "interrupted") return AGENT_TEAM_STATUS.STOPPED;
  // Default: idle covers both an actual `idle` row and an unknown value
  // the runtime has not grown yet (we prefer "no claim" over "loud
  // failure" for an unrecognised string).
  return AGENT_TEAM_STATUS.IDLE;
}

/**
 * Map a `local_runtime_background_tasks.status` (when `kind = 'subagent'`)
 * to the UI vocabulary.
 *
 * Measured values from this machine's db (ticket 06 R8 复核):
 *   • `running`     — the subagent is mid-turn (the only value that
 *                       claims "live" on the parent's tool line)
 *   • `succeeded`   — the subagent finished cleanly
 *   • `failed`      — the subagent ended on an error
 *   • `canceled`    — the subagent was stopped or interrupted
 *
 * `canceled` lands on `stopped` (matches TUI vocabulary), not on `failed`:
 * cancellation is a deliberate user action, not a fault.
 */
export function projectTaskStatus(rawStatus) {
  const s = typeof rawStatus === "string" ? rawStatus.trim() : "";
  if (s === "running") return AGENT_TEAM_STATUS.RUNNING;
  if (s === "succeeded") return AGENT_TEAM_STATUS.DONE;
  if (s === "failed") return AGENT_TEAM_STATUS.FAILED;
  if (s === "canceled") return AGENT_TEAM_STATUS.STOPPED;
  // Unknown / empty — render as idle rather than risk a false "running"
  // claim on an unrecognised future status.
  return AGENT_TEAM_STATUS.IDLE;
}

/**
 * Compose the two projections for a session row that has a live task.
 *
 * The task row's `running` wins — that is the only way to display
 * "running" at all, because the session column is intentionally narrow.
 * When no task is supplied (a subagent row that has not been picked up by
 * the runtime yet, or whose task row has been cleaned up), the session
 * column's projection is the answer.
 *
 * @param {string|undefined|null} sessionRaw
 * @param {string|undefined|null} taskRaw
 * @returns {string} one of `AGENT_TEAM_STATUS`
 */
export function projectAgentStatus(sessionRaw, taskRaw) {
  const fromTask = projectTaskStatus(taskRaw);
  if (fromTask === AGENT_TEAM_STATUS.RUNNING) return fromTask;
  // If the task is in a terminal state, prefer the task projection — a
  // session column stuck at `idle` would otherwise re-paint a `done` /
  // `failed` subagent as "running again".
  if (taskRaw && String(taskRaw).trim() !== "") {
    if (
      fromTask === AGENT_TEAM_STATUS.DONE ||
      fromTask === AGENT_TEAM_STATUS.FAILED ||
      fromTask === AGENT_TEAM_STATUS.STOPPED
    ) {
      return fromTask;
    }
  }
  return projectSessionStatus(sessionRaw);
}

/**
 * True when a status is one the UI should treat as "live" (still being
 * driven by the engine, not yet terminal). Used by the running badge on
 * the parent's task tool line and by the live-render hook in the sidebar
 * session tree.
 */
export function isLiveStatus(uiStatus) {
  return (
    uiStatus === AGENT_TEAM_STATUS.RUNNING ||
    uiStatus === AGENT_TEAM_STATUS.WAITING
  );
}

/** Defensive read for callers that trust nothing. */
export function isUiStatus(value) {
  return typeof value === "string" && UI_STATUSES.has(value);
}
