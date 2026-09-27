// webui/test/lib/agent-team-status.test.js
// Unit tests for server/lib/agent-team-status.js — the DB → UI status
// projection that the Agent Team panel depends on.
//
// Coverage contract (every line here is a documented claim from
// .tickets/webui-parity/06-agent-team-panel.md):
//
//   1. `local_runtime_sessions.status` only carries
//        `idle | interrupted | aborted | error` — measured on this machine,
//        ticket 06 R8. The TUI vocabulary (failed/waiting/running/queued/
//        done/stopped) is a projection-layer vocabulary, NOT a db field.
//   2. `local_runtime_background_tasks.status` carries
//        `running | succeeded | failed | canceled` for `kind = 'subagent'`.
//   3. The UI NEVER reads raw db strings — every consumer must project
//        through this module.
//   4. `projectAgentStatus` must prefer a live task status over a stale
//        session column (otherwise a busy subagent paints as idle).
//   5. `projectAgentStatus` must prefer a terminal task status over the
//        session column (otherwise a finished subagent repaints as idle).
//   6. `isLiveStatus` returns true for `running` and `waiting` only —
//        the parent tool-line running badge depends on it.
//   7. Unknown / nullish inputs fall back to `idle` rather than throwing
//        (a runtime growth path cannot break the panel).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_TEAM_STATUS,
  projectSessionStatus,
  projectTaskStatus,
  projectAgentStatus,
  isLiveStatus,
  isUiStatus,
} from "../../server/lib/agent-team-status.js";

describe("projectSessionStatus — sessions.status → UI", () => {
  test("idle stays idle (the default render for an active session)", () => {
    assert.equal(projectSessionStatus("idle"), AGENT_TEAM_STATUS.IDLE);
  });

  test("interrupted maps to stopped (user-pressed-stop or crash)", () => {
    assert.equal(projectSessionStatus("interrupted"), AGENT_TEAM_STATUS.STOPPED);
  });

  test("aborted maps to failed (engine cancelled the turn — not a fault, but terminal)", () => {
    // Spec note: ticket 06 R8 maps `aborted` to `failed`. We surface that
    // decision through this projection rather than carving it out at every
    // consumer. Adjust this test if the contract changes.
    assert.equal(projectSessionStatus("aborted"), AGENT_TEAM_STATUS.FAILED);
  });

  test("error maps to failed", () => {
    assert.equal(projectSessionStatus("error"), AGENT_TEAM_STATUS.FAILED);
  });

  test("an empty / nullish / unknown string falls back to idle, never throws", () => {
    assert.equal(projectSessionStatus(""), AGENT_TEAM_STATUS.IDLE);
    assert.equal(projectSessionStatus(null), AGENT_TEAM_STATUS.IDLE);
    assert.equal(projectSessionStatus(undefined), AGENT_TEAM_STATUS.IDLE);
    assert.equal(projectSessionStatus("future-status"), AGENT_TEAM_STATUS.IDLE);
  });

  test("whitespace-only input is treated as empty (defensive parse)", () => {
    assert.equal(projectSessionStatus("   "), AGENT_TEAM_STATUS.IDLE);
  });
});

describe("projectTaskStatus — background_tasks.status → UI", () => {
  test("running is the only state that claims live on the parent tool line", () => {
    assert.equal(projectTaskStatus("running"), AGENT_TEAM_STATUS.RUNNING);
  });

  test("succeeded maps to done", () => {
    assert.equal(projectTaskStatus("succeeded"), AGENT_TEAM_STATUS.DONE);
  });

  test("failed maps to failed", () => {
    assert.equal(projectTaskStatus("failed"), AGENT_TEAM_STATUS.FAILED);
  });

  test("canceled maps to stopped (a deliberate user action, not a fault)", () => {
    assert.equal(projectTaskStatus("canceled"), AGENT_TEAM_STATUS.STOPPED);
  });

  test("an empty / unknown task status falls back to idle", () => {
    assert.equal(projectTaskStatus(""), AGENT_TEAM_STATUS.IDLE);
    assert.equal(projectTaskStatus(null), AGENT_TEAM_STATUS.IDLE);
    assert.equal(projectTaskStatus("queued-future"), AGENT_TEAM_STATUS.IDLE);
  });
});

describe("projectAgentStatus — composing both projections", () => {
  test("a running task beats an idle session column", () => {
    // This is the load-bearing case: the parent tool line MUST show
    // "running ▶" while the subagent is busy, even though the engine
    // never wrote `running` into the session row.
    assert.equal(
      projectAgentStatus("idle", "running"),
      AGENT_TEAM_STATUS.RUNNING,
    );
  });

  test("a done task wins over an idle session column (otherwise finished subagents repaint as idle)", () => {
    assert.equal(
      projectAgentStatus("idle", "succeeded"),
      AGENT_TEAM_STATUS.DONE,
    );
  });

  test("a failed task wins over an idle session column", () => {
    assert.equal(
      projectAgentStatus("idle", "failed"),
      AGENT_TEAM_STATUS.FAILED,
    );
  });

  test("a canceled task wins over an idle session column", () => {
    assert.equal(
      projectAgentStatus("idle", "canceled"),
      AGENT_TEAM_STATUS.STOPPED,
    );
  });

  test("the session column still drives the answer when no task is known", () => {
    // e.g. a subagent row exists in the runtime db but the engine has not
    // yet written a background_tasks row for the current turn. We must
    // not claim "running" out of thin air.
    assert.equal(
      projectAgentStatus("error", ""),
      AGENT_TEAM_STATUS.FAILED,
    );
    assert.equal(
      projectAgentStatus("error", null),
      AGENT_TEAM_STATUS.FAILED,
    );
    assert.equal(
      projectAgentStatus("idle", undefined),
      AGENT_TEAM_STATUS.IDLE,
    );
  });

  test("when both columns are empty the answer is idle, not failed", () => {
    assert.equal(projectAgentStatus("", ""), AGENT_TEAM_STATUS.IDLE);
  });

  test("an idle task does NOT silently override a non-idle session column", () => {
    // `idle` is not a definitive task verdict; prefer the session column
    // when the task column says nothing.
    assert.equal(
      projectAgentStatus("error", "idle"),
      AGENT_TEAM_STATUS.FAILED,
    );
    assert.equal(
      projectAgentStatus("interrupted", "idle"),
      AGENT_TEAM_STATUS.STOPPED,
    );
  });
});

describe("isLiveStatus — parent-tool-line running badge", () => {
  test("running is live", () => {
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.RUNNING), true);
  });

  test("waiting is live (engine asked for user input)", () => {
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.WAITING), true);
  });

  test("done / failed / stopped / queued / idle are NOT live", () => {
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.DONE), false);
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.FAILED), false);
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.STOPPED), false);
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.QUEUED), false);
    assert.equal(isLiveStatus(AGENT_TEAM_STATUS.IDLE), false);
  });

  test("an unknown string is never live", () => {
    assert.equal(isLiveStatus("almost-running"), false);
    assert.equal(isLiveStatus(""), false);
    assert.equal(isLiveStatus(null), false);
  });
});

describe("isUiStatus — guard for external payloads", () => {
  test("every AGENT_TEAM_STATUS value is accepted", () => {
    for (const value of Object.values(AGENT_TEAM_STATUS)) {
      assert.equal(isUiStatus(value), true, `${value} should be a UI status`);
    }
  });

  test("raw db strings that are NOT in the UI vocabulary are rejected", () => {
    // "idle" and "running" happen to overlap between the db and UI vocab,
    // but the contract is: a consumer that needs a UI status must receive
    // one from this module's projections. Anything else (a db string,
    // a typo, an older version of the contract) must NOT pass.
    assert.equal(isUiStatus("succeeded"), false); // db-only, no UI equivalent
    assert.equal(isUiStatus("canceled"), false); // db-only, no UI equivalent
    assert.equal(isUiStatus("interrupted"), false); // db-only
    assert.equal(isUiStatus("aborted"), false); // db-only
    assert.equal(isUiStatus("not-a-status"), false); // unknown
  });
});
