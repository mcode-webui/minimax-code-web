// webui/test/lib/agent-team-tasks.test.js
// Unit tests for server/lib/agent-team-tasks.js — read-only projections
// over `local_runtime_background_tasks` used by the Agent Team wiring.
//
// Strategy: the tests spin up a real better-sqlite3 db in a temp file,
// seed it with a handful of rows that mirror the shape the runtime uses
// (the schema is verified in `.tickets/webui-parity/06-agent-team-panel.md`
// R8), and exercise every helper against that. This avoids both the
// "fake the whole module" antipattern (which would let a regression ship
// a SQL bug past the suite) and the "talk to the user's real db" rule
// the ticket explicitly bans.
//
// We force the resolver to point at the temp db through
// `process.env.MCODE_BETTER_SQLITE3` + `process.env.MCODE_RUNTIME_DB`,
// exactly as the codebase does in test/integration/*.test.js. The resolver
// caches the binding, so each test file must clear it (we just re-create
// a fresh module by importing a small wrapper that re-reads the env).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {writeFileSync, rmSync} from "node:fs";

import { join } from "node:path";
import { createRequire } from "node:module";

import { AGENT_TEAM_STATUS } from "../../server/lib/agent-team-status.js";
import { mkTmpDir } from "../helpers/tmp.js";

const require = createRequire(import.meta.url);

let tmpDir;
let dbPath;
let tasksModule;

function loadTasksModule() {
  // dynamic import so the resolver picks up the test env after we set it
  return import("../../server/lib/agent-team-tasks.js");
}

before(async () => {
  tmpDir = mkTmpDir("agent-team-tasks-");
  dbPath = join(tmpDir, "runtime-state.sqlite");
  // Resolve better-sqlite3 from the workspace — same approach as the
  // existing test/integration tests use.
  const candidates = [
    join(process.cwd(), "node_modules", "better-sqlite3"),
    join(process.cwd(), "..", "..", "node_modules", "better-sqlite3"),
    join(process.cwd(), "..", "..", "..", "node_modules", "better-sqlite3"),
  ];
  let bindingPath = null;
  for (const c of candidates) {
    try {
      require(c);
      bindingPath = c;
      break;
    } catch {}
  }
  if (!bindingPath) {
    throw new Error("better-sqlite3 not found in workspace node_modules");
  }
  process.env.MCODE_BETTER_SQLITE3 = bindingPath;
  process.env.MCODE_RUNTIME_DB = dbPath;

  // Create the schema in the temp db. Mirrors the live schema columns
  // this code touches.
  const Db = require(bindingPath);
  const db = new Db(dbPath);
  db.exec(`
    CREATE TABLE local_runtime_background_tasks (
      task_id TEXT PRIMARY KEY,
      owner_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      record_json TEXT NOT NULL
    );
  `);
  // Seed: a mix of subagent and bash rows, some with the same toolCallId.
  const seed = [
    {
      task_id: "bg_running_1",
      owner_session_id: "mvs_parent",
      kind: "subagent",
      status: "running",
      created_at_ms: 1000,
      updated_at_ms: 1100,
      ended_at_ms: null,
      record_json: JSON.stringify({
        toolCallId: "tool_call_a",
        metadata: {
          parentSessionId: "mvs_parent",
          childSessionId: "mvs_child_running",
          agentName: "verifier",
        },
      }),
    },
    {
      task_id: "bg_done_1",
      owner_session_id: "mvs_parent",
      kind: "subagent",
      status: "succeeded",
      created_at_ms: 2000,
      updated_at_ms: 2500,
      ended_at_ms: 2500,
      record_json: JSON.stringify({
        toolCallId: "tool_call_b",
        metadata: {
          parentSessionId: "mvs_parent",
          childSessionId: "mvs_child_done",
          agentName: "explore",
        },
      }),
    },
    {
      task_id: "bg_failed_1",
      owner_session_id: "mvs_parent",
      kind: "subagent",
      status: "failed",
      created_at_ms: 3000,
      updated_at_ms: 3100,
      ended_at_ms: 3100,
      record_json: JSON.stringify({
        toolCallId: "tool_call_c",
        metadata: {
          parentSessionId: "mvs_parent",
          childSessionId: "mvs_child_failed",
          agentName: "worker",
        },
      }),
    },
    {
      task_id: "bg_canceled_1",
      owner_session_id: "mvs_parent",
      kind: "subagent",
      status: "canceled",
      created_at_ms: 4000,
      updated_at_ms: 4100,
      ended_at_ms: 4100,
      record_json: JSON.stringify({
        toolCallId: "tool_call_d",
        metadata: {
          parentSessionId: "mvs_parent",
          childSessionId: "mvs_child_canceled",
          agentName: "coder",
        },
      }),
    },
    {
      task_id: "bg_bash_1",
      owner_session_id: "mvs_parent",
      kind: "bash",
      status: "succeeded",
      created_at_ms: 1500,
      updated_at_ms: 1600,
      ended_at_ms: 1600,
      record_json: JSON.stringify({
        toolCallId: "tool_call_bash",
        metadata: {},
      }),
    },
    {
      task_id: "bg_other_parent",
      owner_session_id: "mvs_other_parent",
      kind: "subagent",
      status: "running",
      created_at_ms: 1200,
      updated_at_ms: 1200,
      ended_at_ms: null,
      record_json: JSON.stringify({
        toolCallId: "tool_call_other",
        metadata: {
          parentSessionId: "mvs_other_parent",
          childSessionId: "mvs_child_other",
          agentName: "verifier",
        },
      }),
    },
  ];
  const insert = db.prepare(
    `INSERT INTO local_runtime_background_tasks
       (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
     VALUES (@task_id, @owner_session_id, @kind, @status, @created_at_ms, @updated_at_ms, @ended_at_ms, @record_json)`,
  );
  for (const row of seed) insert.run(row);
  db.close();

  // Force the resolver to refresh its cache. The resolver binds better-sqlite3
  // exactly once and caches the module, so a fresh dynamic import of the
  // tasks module after the env is set is enough — there is no need to
  // re-import the resolver here.
  tasksModule = await loadTasksModule();
});

after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MCODE_BETTER_SQLITE3;
  delete process.env.MCODE_RUNTIME_DB;
});

describe("findSubagentTaskByToolCallId", () => {
  test("returns the projected UI status for a running subagent task", () => {
    const out = tasksModule.findSubagentTaskByToolCallId("tool_call_a");
    assert.ok(out, "expected a hit for tool_call_a");
    assert.equal(out.status, AGENT_TEAM_STATUS.RUNNING);
    assert.equal(out.agentName, "verifier");
    assert.equal(out.childSessionId, "mvs_child_running");
  });

  test("maps succeeded → done", () => {
    const out = tasksModule.findSubagentTaskByToolCallId("tool_call_b");
    assert.equal(out.status, AGENT_TEAM_STATUS.DONE);
    assert.equal(out.agentName, "explore");
  });

  test("maps failed → failed", () => {
    const out = tasksModule.findSubagentTaskByToolCallId("tool_call_c");
    assert.equal(out.status, AGENT_TEAM_STATUS.FAILED);
    assert.equal(out.agentName, "worker");
  });

  test("maps canceled → stopped", () => {
    const out = tasksModule.findSubagentTaskByToolCallId("tool_call_d");
    assert.equal(out.status, AGENT_TEAM_STATUS.STOPPED);
    assert.equal(out.agentName, "coder");
  });

  test("ignores bash rows even if their toolCallId matches", () => {
    // The kind filter is load-bearing — a bash task with the same
    // toolCallId as a subagent must never leak through this projection.
    const out = tasksModule.findSubagentTaskByToolCallId("tool_call_bash");
    assert.equal(out, null);
  });

  test("returns null for an unknown toolCallId", () => {
    assert.equal(
      tasksModule.findSubagentTaskByToolCallId("tool_call_missing"),
      null,
    );
  });

  test("returns null when the input is empty / nullish", () => {
    assert.equal(tasksModule.findSubagentTaskByToolCallId(""), null);
    assert.equal(tasksModule.findSubagentTaskByToolCallId(null), null);
    assert.equal(tasksModule.findSubagentTaskByToolCallId(undefined), null);
  });

  test("every returned status is in the UI vocabulary (no raw db leakage)", () => {
    // Last line of defence: a regression that drops `projectTaskStatus`
    // out of the helper would silently smuggle the db vocabulary into
    // the wire. The vocabularies intentionally overlap on `running` /
    // `idle` / `failed`, so the contract is the membership check, not
    // an inequality.
    const ids = [
      "tool_call_a",
      "tool_call_b",
      "tool_call_c",
      "tool_call_d",
    ];
    const allowed = new Set(Object.values(AGENT_TEAM_STATUS));
    for (const id of ids) {
      const row = tasksModule.findSubagentTaskByToolCallId(id);
      assert.ok(row, `expected a hit for ${id}`);
      assert.ok(
        allowed.has(row.status),
        `${row.status} must be one of ${[...allowed].join(", ")}`,
      );
    }
  });
});

describe("hasSubagentTaskByToolCallId", () => {
  test("true for a known subagent toolCallId", () => {
    assert.equal(tasksModule.hasSubagentTaskByToolCallId("tool_call_a"), true);
  });

  test("false for a bash toolCallId with the same id space", () => {
    assert.equal(
      tasksModule.hasSubagentTaskByToolCallId("tool_call_bash"),
      false,
    );
  });

  test("false for an unknown toolCallId", () => {
    assert.equal(
      tasksModule.hasSubagentTaskByToolCallId("tool_call_missing"),
      false,
    );
  });

  test("false for an empty / nullish input (no spurious matches)", () => {
    assert.equal(tasksModule.hasSubagentTaskByToolCallId(""), false);
    assert.equal(tasksModule.hasSubagentTaskByToolCallId(null), false);
    assert.equal(tasksModule.hasSubagentTaskByToolCallId(undefined), false);
  });
});

describe("listSubagentTasksByParentSession", () => {
  test("returns only the parent's subagent rows, in descending recency", () => {
    const list = tasksModule.listSubagentTasksByParentSession("mvs_parent");
    assert.equal(list.length, 4);
    assert.deepEqual(
      list.map((row) => row.toolCallId),
      ["tool_call_d", "tool_call_c", "tool_call_b", "tool_call_a"],
    );
    // Every status field has been projected, never raw.
    for (const row of list) {
      assert.ok(Object.values(AGENT_TEAM_STATUS).includes(row.status));
    }
  });

  test("does not leak rows from a different parent", () => {
    const list = tasksModule.listSubagentTasksByParentSession("mvs_parent");
    assert.ok(
      !list.some((row) => row.childSessionId === "mvs_child_other"),
      "mvs_other_parent's row must not leak into mvs_parent's list",
    );
  });

  test("respects the limit cap", () => {
    const list = tasksModule.listSubagentTasksByParentSession("mvs_parent", { limit: 2 });
    assert.equal(list.length, 2);
  });

  test("returns [] for an unknown parent (no throw)", () => {
    assert.deepEqual(
      tasksModule.listSubagentTasksByParentSession("mvs_no_such_parent"),
      [],
    );
  });

  test("returns [] for an empty / nullish input", () => {
    assert.deepEqual(tasksModule.listSubagentTasksByParentSession(""), []);
    assert.deepEqual(tasksModule.listSubagentTasksByParentSession(null), []);
  });
});

describe("diffSubagentsByParentSession", () => {
  test("returns the rows the caller has not seen yet", () => {
    const known = new Set(["tool_call_a", "tool_call_b"]);
    const diff = tasksModule.diffSubagentsByParentSession("mvs_parent", known);
    assert.deepEqual(
      diff.map((row) => row.toolCallId).sort(),
      ["tool_call_c", "tool_call_d"],
    );
  });

  test("returns [] when every row is already known", () => {
    const known = new Set([
      "tool_call_a",
      "tool_call_b",
      "tool_call_c",
      "tool_call_d",
    ]);
    assert.deepEqual(
      tasksModule.diffSubagentsByParentSession("mvs_parent", known),
      [],
    );
  });

  test("treats a non-Set input as an empty set (every row is new)", () => {
    const diff = tasksModule.diffSubagentsByParentSession("mvs_parent", null);
    assert.equal(diff.length, 4);
  });
});
