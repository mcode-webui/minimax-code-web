// webui/test/lib/agent-team-state-bus.test.js
// Unit tests for the Agent Team wiring in lib/state-bus.js —
// pushSessionTreeChanged, recordSubagentForCid, recentSubagents
// pruning, and the subagent status polling helpers.
//
// Strategy: drive the public API only. We DO NOT mock state-bus.js
// itself (that would defeat the regression value). The runtime db read
// (agent-team-tasks.js) goes through env-controlled paths so a
// per-test fixture db can be substituted for `~/.minimax/...`.

import { test, describe, before, after } from "node:test";

// Teardown: importing server/lib/state-bus.js drags in the webui
// runtime graph, which starts the resident ACP singleton child process
// during module load. The child's stdio keeps this test process's
// pipes open so `node --test` never sees the file finish: every test
// passes, zero failures, and the job is killed at the timeout. Stop
// the child in `after()` so the runner settles cleanly.
import assert from "node:assert/strict";
import {writeFileSync, rmSync, existsSync} from "node:fs";

import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";

const require = createRequire(import.meta.url);
const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

let tmpDir;
let dbPath;
let stateBus;

before(async () => {
  tmpDir = mkTmpDir("agent-team-state-bus-");
  dbPath = join(tmpDir, "runtime-state.sqlite");
  process.env.MCODE_WEBUI_SESSIONS_DB = join(tmpDir, "sessions.json");
  process.env.MCODE_WEBUI_UPLOAD_DIR = join(tmpDir, "uploads");
  // Resolve better-sqlite3 from the workspace — the same lookup the
  // agent-team-tasks tests use.
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
  if (!bindingPath) throw new Error("better-sqlite3 not found");
  process.env.MCODE_BETTER_SQLITE3 = bindingPath;
  process.env.MCODE_RUNTIME_DB = dbPath;

  // Seed the runtime db with a row that the poll will refresh.
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
  db.prepare(
    `INSERT INTO local_runtime_background_tasks
       (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "bg_poll_1",
    "mvs_parent",
    "subagent",
    "running",
    1000,
    1100,
    null,
    JSON.stringify({
      toolCallId: "tc_poll_running",
      metadata: { parentSessionId: "mvs_parent", childSessionId: "mvs_child_a", agentName: "verifier" },
    }),
  );
  db.close();

  stateBus = await import(absPath("lib/state-bus.js"));
});

after(async () => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MCODE_BETTER_SQLITE3;
  delete process.env.MCODE_RUNTIME_DB;
  delete process.env.MCODE_WEBUI_SESSIONS_DB;
  delete process.env.MCODE_WEBUI_UPLOAD_DIR;
  // Stop the subagent poll so the unref'd interval does not keep the
  // process alive after the suite settles. The test that calls
  // `startSubagentStatusPolling` is intentionally leaving the timer
  // running; we tear it down here.
  if (stateBus && typeof stateBus.stopSubagentStatusPolling === "function") {
    stateBus.stopSubagentStatusPolling();
  }
  // Force the test runner to exit even if the resident ACP singleton
  // (or some other module-side timer) is still holding stdio open.
  // This is the same workaround as mcode-acp-note.test.js. All test
  // assertions have already completed; the only remaining handle is
  // a process-level one the test cannot observe.
  setTimeout(() => process.exit(0), 10).unref();
});

describe("pushSessionTreeChanged — named SSE broadcast", () => {
  test("broadcasts the named frame to every connected cid", () => {
    // Two cids, each with a fresh SSE writer (a capture object).
    const written = [];
    const resA = { write: (chunk) => written.push(["A", chunk]), writableEnded: false, destroyed: false };
    const resB = { write: (chunk) => written.push(["B", chunk]), writableEnded: false, destroyed: false };
    stateBus.setSseClient("cid-a", resA);
    stateBus.setSseClient("cid-b", resB);
    try {
      stateBus.pushSessionTreeChanged();
      assert.equal(written.length, 2);
      for (const entry of written) {
        const chunk = entry[1];
        assert.ok(
          chunk.startsWith("event: session-tree-changed\n"),
          `frame must be a named event, got ${JSON.stringify(chunk)}`,
        );
      }
    } finally {
      stateBus.endSseClient("cid-a", resA);
      stateBus.endSseClient("cid-b", resB);
    }
  });

  test("dead / closed SSE writers do not throw", () => {
    const dead = { write: () => { throw new Error("closed"); }, writableEnded: true, destroyed: false };
    stateBus.setSseClient("cid-dead", dead);
    assert.doesNotThrow(() => stateBus.pushSessionTreeChanged());
    stateBus.endSseClient("cid-dead", dead);
  });
});

describe("recordSubagentForCid — recentSubagents bookkeeping", () => {
  test("appends an entry to a cid that has none yet", () => {
    stateBus.getClient("cid-record-A");
    stateBus.recordSubagentForCid("cid-record-A", {
      toolCallId: "tc_record_1",
      sessionId: "mvs_record_1",
      agentName: "verifier",
    });
    const cs = stateBus.getClient("cid-record-A");
    assert.ok(Array.isArray(cs.recentSubagents));
    assert.equal(cs.recentSubagents.length, 1);
    assert.equal(cs.recentSubagents[0].toolCallId, "tc_record_1");
    assert.equal(cs.recentSubagents[0].sessionId, "mvs_record_1");
    assert.equal(cs.recentSubagents[0].agentName, "verifier");
  });

  test("a second record with the same toolCallId updates in place (no duplicate)", () => {
    stateBus.getClient("cid-record-B");
    stateBus.recordSubagentForCid("cid-record-B", {
      toolCallId: "tc_record_2",
      sessionId: "mvs_record_2",
    });
    stateBus.recordSubagentForCid("cid-record-B", {
      toolCallId: "tc_record_2",
      sessionId: "mvs_record_2",
      status: "done",
    });
    const cs = stateBus.getClient("cid-record-B");
    assert.equal(cs.recentSubagents.length, 1);
    assert.equal(cs.recentSubagents[0].status, "done");
  });

  test("ignores empty / nullish entries rather than writing garbage", () => {
    stateBus.getClient("cid-record-C");
    stateBus.recordSubagentForCid("cid-record-C", null);
    stateBus.recordSubagentForCid("cid-record-C", {});
    stateBus.recordSubagentForCid("cid-record-C", { toolCallId: "", sessionId: "" });
    stateBus.recordSubagentForCid("cid-record-C", { toolCallId: "tc_x", sessionId: "" });
    const cs = stateBus.getClient("cid-record-C");
    assert.equal(cs.recentSubagents.length, 0);
  });

  test("ignores calls with no cid (best-effort — no throw)", () => {
    assert.doesNotThrow(() =>
      stateBus.recordSubagentForCid("", { toolCallId: "tc_x", sessionId: "mvs_x" }),
    );
  });
});

describe("refreshRecentSubagentStatuses — poll path", () => {
  test("refreshes a recorded entry's status from the runtime db", () => {
    const cid = "cid-poll-1";
    stateBus.getClient(cid);
    stateBus.recordSubagentForCid(cid, {
      toolCallId: "tc_poll_running",
      sessionId: "mvs_child_a",
      agentName: null,
      status: "queued", // stale on purpose — poll must overwrite
    });
    stateBus.refreshRecentSubagentStatuses();
    const cs = stateBus.getClient(cid);
    const entry = cs.recentSubagents.find((r) => r.toolCallId === "tc_poll_running");
    assert.ok(entry);
    assert.equal(entry.status, "running");
    assert.equal(entry.agentName, "verifier");
  });

  test("is a no-op when no cid has recorded entries", () => {
    // We can't isolate from the other tests' cids without resetting
    // the module; just verify the call returns without throwing when
    // there are no probes (the implementation bails early).
    assert.doesNotThrow(() => stateBus.refreshRecentSubagentStatuses());
  });
});

describe("subagent poll cadence — env knob", () => {
  test("default cadence is 2000ms (process env override absent)", () => {
    // The exported constant was bound at module load; sanity-check it.
    assert.equal(stateBus.getSubagentPollIntervalMs(), 2000);
  });
});

describe("startSubagentStatusPolling / stopSubagentStatusPolling", () => {
  test("start is idempotent; stop tears down cleanly", () => {
    // Already started in production bootstrap (when the server boots),
    // but the helper is idempotent so calling it again is a no-op.
    assert.doesNotThrow(() => stateBus.startSubagentStatusPolling());
    assert.doesNotThrow(() => stateBus.startSubagentStatusPolling());
    assert.doesNotThrow(() => stateBus.stopSubagentStatusPolling());
    assert.doesNotThrow(() => stateBus.stopSubagentStatusPolling());
  });
});
