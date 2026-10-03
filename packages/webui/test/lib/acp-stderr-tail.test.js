// webui/test/lib/acp-stderr-tail.test.js
//
// D2 — the engine subprocess's stderr used to reach nobody.
//
// `packages/webui/acp.mjs` forwarded stderr to the server's own stderr
// only under `this.debug`, so a production webui watched the engine die
// with `agent_name_conflict_migration_failed:lock` on the pipe and
// surfaced a single actionable-looking non-action: `mcode acp exited
// (code=1)`. Exit codes do not say which lock; the engine's line does.
//
// The fix carries a bounded tail of that stream inside the failure
// alert's `data.stderrTail`. These assertions run against REAL fake
// engine subprocesses (a stubbed `McodeAcpClient` would prove only that
// the stub's own buffer works) and against the real `runMcodeAcp`, so
// the bytes cross a genuine pipe, a genuine `spawn`, and a genuine
// `pushAlert`.
//
// What is pinned here, and why each half matters:
//   * the tail survives `debug: false` — the whole point of the fix;
//   * it is BOUNDED and marked when truncated, so a chatty engine cannot
//     turn a 200-byte alert into a 200KB one nor hide the failure behind
//     its own earlier noise;
//   * a silent engine leaves the alert's `data` byte-identical to what it
//     was before the field existed (absent, not `""`);
//   * a clean code-0 run raises no error alert at all.

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

const WEBUI_DIR = resolve(import.meta.dirname, "..", "..");
const absWebuiPath = (rel) => pathToFileURL(resolve(WEBUI_DIR, rel)).href;

const { McodeAcpClient } = await import(absWebuiPath("acp.mjs"));
const alerts = await import(absWebuiPath("server/lib/alerts.js"));
const mcodeAcp = await import(absWebuiPath("server/lib/mcode-acp.js"));

// The engine failure the field report actually lost. Kept as a literal
// so a rename on the engine side shows up here as a failing test rather
// than as a silently narrowed assertion.
const ENGINE_FATAL = "agent_name_conflict_migration_failed:lock";

// ---------- fake engines ----------

// Crashes on startup: the exact shape that produced `code=1` and no
// diagnosis. The noise goes to stderr BEFORE the fatal line, so an
// unbounded implementation would have shipped the last 2KB — mostly
// noise — and dropped the line the operator needed. `process.exitCode`
// (not `process.exit()`) lets the stderr pipe flush before the process
// ends; an explicit exit() truncates piped writes and would make this
// test flaky for the wrong reason.
const CRASH_ENGINE = `
for (let i = 1; i <= 200; i++) {
  process.stderr.write("migrating agent name registry, step " + i + " ...\\n");
}
process.stderr.write("${ENGINE_FATAL} at ~/.minimax-code/agents.lock\\n");
process.exitCode = 1;
`;

// Dies the same way, but says nothing. The reverse half: an engine that
// never spoke must leave the alert's shape untouched.
const SILENT_CRASH_ENGINE = `
process.exitCode = 1;
`;

// Completes one full turn and exits 0. A chatty-but-healthy engine is
// the other half: its stderr is retained, yet nothing is an error, so
// `stderrTail` must not become a failure signal of its own.
const CLEAN_ENGINE = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stderr.write("[mcode] resuming 3 sessions\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, configOptions: [] } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-clean", configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      setTimeout(() => { process.exitCode = 0; process.stdin.pause(); }, 20);
    } else if (msg.method && msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`;

let dir = null;
const engines = {};

before(() => {
  dir = mkTmpDir("webui-acp-stderr-");
  for (const [name, source] of Object.entries({
    crash: CRASH_ENGINE,
    silent: SILENT_CRASH_ENGINE,
    clean: CLEAN_ENGINE,
  })) {
    engines[name] = join(dir, `${name}-engine.mjs`);
    writeFileSync(engines[name], source);
  }
});

after(async () => {
  // Importing lib/mcode-acp.js pulls in lib/acp-client.js, which starts a
  // resident engine singleton on module load. Left running it keeps a
  // spawned process — and this test file's event loop — alive forever.
  const acpClient = await import(absWebuiPath("server/lib/acp-client.js"));
  try {
    acpClient.shutdownMcodeAcpSingleton();
  } catch {
    /* never started, or already gone */
  }
  await new Promise((r) => setTimeout(r, 50));
  delete process.env.MCODE_CMD;
  if (dir) rmTmpDir(dir);
});

beforeEach(() => {
  alerts._resetForTests();
});

const running = [];

afterEach(() => {
  while (running.length) running.pop().stop();
  delete process.env.MCODE_CMD;
  alerts._resetForTests();
});

/** The `cs` runMcodeAcp reads before the engine is even reached. */
function makeCs() {
  return {
    model: { name: "minimax_api/MiniMax-M3" },
    workspace: { dir: dir },
    sessionId: null,
    mcodeSessionId: null,
    sessionTitle: "Untitled",
    chat: [],
    usage: {},
    context: { used: 0, limit: 0, percent: 0, tokens: 0 },
    running: { active: false },
  };
}

/** The failure alerts runMcodeAcp raised, newest last. */
function errorAlerts() {
  return alerts.getRecentAlerts().filter((a) => a.src === "mcode-acp" && a.level === "error");
}

describe("engine stderr reaches the failure alert (D2)", () => {
  test("a crash alert carries the truncated stderr tail, with debug off", async () => {
    process.env.MCODE_CMD = engines.crash;

    const r = await mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs: makeCs(),
      cid: "cid-stderr-crash",
      sessionId: null,
    });

    assert.equal(r.status, "failed", "the engine crashed, so the turn fails");

    const raised = errorAlerts();
    assert.equal(raised.length, 1, `expected exactly one engine error alert, got ${JSON.stringify(raised)}`);
    const [alert] = raised;

    // The lost diagnostic is back, and it is the reason the turn failed.
    assert.match(alert.data.stderrTail, new RegExp(ENGINE_FATAL));
    assert.match(alert.msg, /mcode acp exited \(code=1/);
  });

  test("the tail is bounded and marked when truncated", async () => {
    process.env.MCODE_CMD = engines.crash;

    await mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs: makeCs(),
      cid: "cid-stderr-bounded",
      sessionId: null,
    });

    const { stderrTail } = errorAlerts()[0].data;

    // 200 lines of ~45 bytes each: an unbounded tail would carry the
    // whole 9KB, and a byte-unbounded alert is a log-flooding vector.
    assert.ok(
      stderrTail.length < 2048 + 200,
      `the tail must stay near its 2KB bound, got ${stderrTail.length} chars`,
    );
    assert.match(stderrTail, /^\[acp stderr truncated, showing the tail\]/);
    // Truncation is stated, not silent — an operator must be able to
    // tell "that was all" from "that was the end of what we kept".
    assert.doesNotMatch(
      stderrTail,
      /migrating agent name registry, step 1 /,
      "the earliest noise must have been dropped, not carried",
    );
  });

  test("the alert's own shape is unchanged — stderrTail is additive", async () => {
    process.env.MCODE_CMD = engines.crash;

    await mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs: makeCs(),
      cid: "cid-stderr-shape",
      sessionId: null,
    });

    const [alert] = errorAlerts();
    // Every pre-existing field, untouched. Consumers switching on the
    // alert contract (SSE /api/alerts, the audit event) must not have
    // to learn a new required field.
    assert.equal(alert.level, "error");
    assert.equal(alert.src, "mcode-acp");
    assert.equal(alert.cid, "cid-stderr-shape");
    assert.equal(alert.sessionId, null);
    assert.equal(alert.data.phase, "start-or-load");
    assert.equal(alert.count, 1);
  });

  test("a silent engine leaves the alert data exactly as it was", async () => {
    process.env.MCODE_CMD = engines.silent;

    await mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs: makeCs(),
      cid: "cid-stderr-silent",
      sessionId: null,
    });

    const raised = errorAlerts();
    assert.equal(raised.length, 1);
    // Absent, not `""`: an operator (and a deduped alert diff) should
    // not be able to tell this alert from one raised before the fix.
    assert.deepEqual(raised[0].data, { phase: "start-or-load" });
  });

  test("a clean code-0 run raises no failure alert even with stderr output", async () => {
    process.env.MCODE_CMD = engines.clean;

    const r = await mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs: makeCs(),
      cid: "cid-stderr-clean",
      sessionId: null,
    });

    assert.equal(r.status, "succeeded", `clean engine run failed: ${JSON.stringify(r.error)}`);
    // The engine did write to stderr. Retaining it must not turn
    // ordinary engine chatter into a failure signal.
    assert.deepEqual(errorAlerts(), []);
  });
});

describe("McodeAcpClient stderr tail", () => {
  test("the tail is readable after a crash, and empty before anything is written", async () => {
    process.env.MCODE_CMD = engines.crash;
    const client = new McodeAcpClient({ debug: false });
    running.push(client);

    assert.equal(client.stderrTail, "", "nothing on the wire yet, so nothing to report");

    const exited = new Promise((res) => client.once("exit", res));
    await assert.rejects(() => client.start());
    await exited;

    assert.match(client.stderrTail, new RegExp(ENGINE_FATAL));
    assert.match(client.stderrTail, /truncated/);
  });

  test("start() resets the tail so one process cannot be blamed for another's crash", async () => {
    process.env.MCODE_CMD = engines.crash;
    const client = new McodeAcpClient({ debug: false });
    running.push(client);

    const firstExit = new Promise((res) => client.once("exit", res));
    await assert.rejects(() => client.start());
    await firstExit;
    assert.match(client.stderrTail, new RegExp(ENGINE_FATAL));

    // A restart begins a NEW subprocess, whose stderr starts empty. The
    // dead process's crash text must not survive into the next run and
    // re-appear on some unrelated failure later.
    process.env.MCODE_CMD = engines.clean;
    const restarted = client.start();
    // The reset happens before the spawn, so it is observable the moment
    // `start()` is called. Whether THIS run goes on to succeed or fail
    // is beside the point: the dead process's crash text is already gone.
    assert.doesNotMatch(client.stderrTail, new RegExp(ENGINE_FATAL));
    restarted.catch(() => {});
  });
});
