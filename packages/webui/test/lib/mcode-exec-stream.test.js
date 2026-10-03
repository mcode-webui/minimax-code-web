// webui/test/lib/mcode-exec-stream.test.js
// D1: the exec transport's stream-json CONSUMER, end to end.
//
// Before D1, `collectExecResult` dispatched on `delta` / `message` /
// `exec.result` — the supervisor's internal `TuiStreamEvent` names — while
// `mcode exec --output-format stream-json` writes only the projected
// `ExecEvent` union (packages/tui/src/headless/events.ts:27-48). The two
// name families have an empty intersection, so nothing the wire wrote was
// ever read: no streaming delta, no session id, no usage, no terminal
// status. These tests drive the real parser with the real wire bytes and
// assert what lands in the client state the front end renders.
//
// The wire is produced by `ExecEventProjector` itself, imported from the
// tui package, so the fixture cannot drift from what the CLI actually
// emits — a hand-written JSON literal in a test is a claim about the
// wire; a projected event is the wire. `TuiStreamEvent` inputs are the
// supervisor's own delivery events, which is the one layer where
// `delta`/`message` legitimately exist: the projector is what turns them
// into the `ExecEvent`s the parser must read.
//
// The child process is a real one (a tiny node script in a tmpdir that
// replays a projected event stream to stdout), so the test exercises the
// actual stdout -> line-splitting -> JSON.parse path rather than a stub.

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mkTmpDir } from "../helpers/tmp.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const absPath = (rel) =>
  pathToFileURL(join(TEST_DIR, "..", "..", "server", rel)).href;

// The state-bus is mocked down to the three calls `collectExecResult`
// makes into it. The real module is not a passive registry: the first
// `pushStateFor` walks into the acp client singleton and starts a real
// subprocess, which then outlives the test file. The parser's behaviour
// under test is exactly what happens BETWEEN those three calls, so
// stubbing them removes a live side effect without touching it.
mock.module(absPath("lib/state-bus.js"), {
  namedExports: {
    setActiveChild: () => {},
    clearActiveChild: () => {},
    pushStateFor: () => {},
  },
});

const { collectExecResult } = await import(absPath("lib/mcode-exec.js"));
const { ExecEventProjector } = await import(
  pathToFileURL(join(TEST_DIR, "..", "..", "..", "tui", "src", "headless", "events.ts")).href
);

const RUN = { runId: "run_d1", sessionId: "mvs_d1session", turnId: "turn_d1" };

// `TuiStreamEvent` inputs in the shapes `projectItems` reads
// (events.ts:141-177): an assistant `delta` carries thinking/content
// deltas and tool calls, an assistant `message` carries the final text.
const delta = (content, extra = {}) => ({
  type: "delta",
  role: "assistant",
  turnId: RUN.turnId,
  messageId: "msg_1",
  ...extra,
  content,
});
const message = (extra) => ({
  type: "message",
  message: { id: "msg_1", role: "assistant", turnId: RUN.turnId, ...extra },
});

/** The exact bytes `mcode exec --output-format stream-json` writes for
 * one turn: `ExecEventProjector.project()` per delivery event, then
 * `complete(result)`. Returned as JSONL. */
function projectWire(deliveries, result) {
  const projector = new ExecEventProjector({ ...RUN, resumed: false, nowMs: () => 0 });
  const events = deliveries.flatMap((d) => projector.project(d));
  events.push(...projector.complete(result));
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A real child that reads `wire` from stdin, replays it to stdout one
 * line at a time (so the parser sees real chunk boundaries), then exits —
 * the shape it is handed in production, where the prompt arrives on stdin
 * and the event stream leaves on stdout. */
function spawnWireEmitter(wire, { holdMs = 0 } = {}) {
  const dir = mkTmpDir("mcode-exec-stream-");
  const script = join(dir, "emit.mjs");
  writeFileSync(
    script,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let buf = "";
rl.on("line", (l) => { buf += l + "\\n"; });
rl.on("close", async () => {
  for (const line of buf.split("\\n")) {
    if (!line) continue;
    process.stdout.write(line + "\\n");
    await new Promise((r) => setTimeout(r, 1));
  }
  ${holdMs ? `await new Promise((r) => setTimeout(r, ${holdMs}));` : ""}
  process.exit(0);
});
`,
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(wire);
  return child;
}

/** The client-state fields `collectExecResult` reads, spelled out rather
 * than taken from `makeClientState()`: importing the state-bus here
 * would boot the module's process singletons, and the shape is already
 * pinned by sessions-reset-context.check.mjs. */
function makeCs() {
  return {
    chat: [],
    model: { name: "test-model" },
    context: {
      tokens: 0, used: 0, percent: 0, limit: 512000, tps: 0,
      estimated: false, lastUsageAt: null, thinkingStatus: "Idle",
    },
    usage: { sessionInput: 0, sessionOutput: 0, sessionTotal: 0 },
    running: {
      active: false, prompt: null, pid: null, startedAt: null,
      model: null, sessionId: null, lastDeltaAt: null, tps: 0,
    },
  };
}

/** Run one turn through the real parser and resolve with everything the
 * front end would see. `cid` is null so the state-bus run/child
 * registries stay out of the way — this test is about the parser. */
function runTurn(wire, opts) {
  const cs = makeCs();
  const child = spawnWireEmitter(wire, opts);
  return collectExecResult({
    child,
    label: "prompt",
    model: cs.model.name,
    cs,
    cid: null,
    sessionId: null,
  }).then((r) => ({ r, cs, child }));
}

describe("exec transport — the stream-json consumer (D1)", () => {

  test("a streamed turn lands incremental text in the chat buffer and the result", async () => {
    const wire = projectWire(
      [
        // The projector splits one delivery event into a reasoning item
        // and an agent_message item, so a real turn delivers thinking and
        // content in SEPARATE deltas — a delta carrying both projects to
        // two items per line, which would interleave the ▲ and ● lines.
        { ...delta(""), thinking: "think" },
        { ...delta(""), thinking: "ing" },
        delta("Let me "),
        delta("check"),
        delta(" that for you."),
      ],
      {
        schemaVersion: 1,
        type: "exec.result",
        runId: RUN.runId,
        sessionId: RUN.sessionId,
        turnId: RUN.turnId,
        status: "succeeded",
        usage: { totalTokens: 120, inputTokens: 80, outputTokens: 40 },
        durationMs: 4321,
      },
    );
    const { r, cs } = await runTurn(wire);
    // The answer arrived as deltas, not from a terminal line.
    assert.equal(r.answer, "Let me check that for you.");
    assert.equal(r.thinking, "thinking");
    assert.equal(r.status, "succeeded");
    assert.equal(r.sessionId, RUN.sessionId);
    assert.equal(r.usage.totalTokens, 120);
    assert.equal(r.durationMs, 4321);
    // The streaming lines are what the front end rendered: an `▲`
    // reasoning line and a `●` answer line, cursor stripped at finalize.
    const answerLines = cs.chat.filter((l) => l.startsWith("● "));
    const thinkingLines = cs.chat.filter((l) => l.startsWith("▲ "));
    assert.equal(thinkingLines.length, 1, "one reasoning line");
    assert.equal(thinkingLines[0], "▲ thinking");
    assert.equal(answerLines.length, 1, "one answer line");
    assert.equal(answerLines[0], "● Let me check that for you.");
    // Usage reached the conversation counters, so the context panel moves.
    assert.equal(cs.context.used, 120);
    assert.equal(cs.usage.sessionInput, 80);
    assert.equal(cs.usage.sessionOutput, 40);
    assert.equal(cs.context.estimated, false);
    // finalize cleared the running claim.
    assert.equal(cs.running.active, false);
    assert.equal(cs.context.thinkingStatus, "Idle");
  });

  test("the chat buffer grows DURING the turn, before the terminal event", async () => {
    // The regression this whole fix exists for: nothing reached the
    // buffer until the process was already over. A wire that stalls
    // between the first delta and its terminal events must still show the
    // partial text while the child is alive.
    const projector = new ExecEventProjector({ ...RUN, resumed: false, nowMs: () => 0 });
    const head = [
      ...projector.project(delta("partial ")),
      ...projector.project(delta("answer")),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    const cs = makeCs();
    // The child holds the terminal events back for 30s, so the window in
    // which "the run is still open" is not a timing accident. It is
    // SIGKILLed below, so the hold never elapses and the test costs no
    // wall-clock time.
    const child = spawnWireEmitter(head, { holdMs: 30000 });
    const done = collectExecResult({
      child, label: "prompt", model: cs.model.name, cs, cid: null, sessionId: null,
    });
    // Wait for the streamed lines to appear, while the run is still open.
    // The predicate is the FULL expected line, not "a `● ` line exists":
    // the first `contentDelta` already creates that line, so a predicate
    // that loose races the second one and reads a half-written turn. The
    // bound is generous on purpose — it is node startup plus module load
    // for a freshly spawned child under a loaded test gate, and a tight
    // bound here shows up as a flake rather than as a defect.
    const streamed = "● partial answer ▍";
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !cs.chat.includes(streamed)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // The child is signalled by the PID this test spawned, in a finally
    // so a failed assertion cannot leave a 30s hold running and hang the
    // file.
    try {
      const midRun = cs.chat.filter((l) => l.startsWith("● "));
      assert.equal(midRun.length, 1, "the answer line exists mid-run");
      assert.equal(midRun[0], streamed, "with the live streaming cursor");
      assert.equal(cs.running.active, true, "the turn is still running");
    } finally {
      child.kill("SIGKILL");
      await done;
    }
  });

  test("a turn that never streamed still delivers its answer and status", async () => {
    // No delta at all: the agent's whole message arrives as one
    // `message` event, which the projector emits as `item.completed` with
    // the full `content`. Before D1 this produced an empty answer.
    const wire = projectWire(
      [message({ content: "one shot answer" })],
      {
        schemaVersion: 1,
        type: "exec.result",
        runId: RUN.runId,
        sessionId: RUN.sessionId,
        turnId: RUN.turnId,
        status: "succeeded",
        durationMs: 12,
      },
    );
    const { r, cs } = await runTurn(wire);
    assert.equal(r.answer, "one shot answer");
    assert.equal(r.status, "succeeded");
    assert.equal(r.sessionId, RUN.sessionId);
    assert.equal(cs.chat.filter((l) => l.startsWith("● ")).length, 1);
  });

  test("a failed turn reports the engine's status and error", async () => {
    const wire = projectWire(
      [delta("partial")],
      {
        schemaVersion: 1,
        type: "exec.result",
        runId: RUN.runId,
        sessionId: RUN.sessionId,
        turnId: RUN.turnId,
        status: "failed",
        error: { code: "internal", message: "engine exploded" },
        durationMs: 7,
      },
    );
    const { r, cs } = await runTurn(wire);
    assert.equal(r.status, "failed");
    assert.equal(r.error.message, "engine exploded");
    // `turn.failed` also carries it, and the last word wins only because
    // the terminal event comes second — the answer is not discarded.
    assert.equal(r.answer, "partial");
    assert.equal(cs.running.active, false);
  });

  test("a tool_call item is consumed without becoming a chat line", async () => {
    // The item stream is now read; `tool_call` items carry a toolCall
    // payload instead of text, so they must be dropped rather than
    // rendered as an empty `●` line. This is the same fact
    // EXEC_CAPABILITIES.toolSkillInvocation records.
    const wire = projectWire(
      [
        delta("before", {
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a" } }],
        }),
        delta(" after"),
      ],
      {
        schemaVersion: 1,
        type: "exec.result",
        runId: RUN.runId,
        sessionId: RUN.sessionId,
        turnId: RUN.turnId,
        status: "succeeded",
        durationMs: 3,
      },
    );
    const { r, cs } = await runTurn(wire);
    assert.equal(r.answer, "before after");
    assert.equal(
      cs.chat.filter((l) => l.includes("▍") || l.trim() === "●").length,
      0,
      "no empty or cursor-bearing line is left behind",
    );
    assert.equal(cs.chat.filter((l) => l.startsWith("● ")).length, 1);
  });

  test("a session.resumed wire yields the resumed session id", async () => {
    // The `--session <id>` re-entry path: the wire says which session the
    // run entered, and the parser has to hand it back so the NEXT turn
    // can continue it. This is what makes exec multi-turn at all.
    const projector = new ExecEventProjector({
      ...RUN, sessionId: "mvs_resumed", resumed: true, nowMs: () => 0,
    });
    const events = [
      ...projector.project(delta("resumed answer")),
      ...projector.complete({
        schemaVersion: 1,
        type: "exec.result",
        runId: RUN.runId,
        sessionId: "mvs_resumed",
        turnId: RUN.turnId,
        status: "succeeded",
        durationMs: 5,
      }),
    ];
    const wire = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const { r } = await runTurn(wire);
    assert.equal(r.sessionId, "mvs_resumed");
    assert.equal(r.answer, "resumed answer");
  });
});
