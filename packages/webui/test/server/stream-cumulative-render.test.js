// webui/test/server/stream-cumulative-render.test.js
//
// Regression pin for session-isolation/06 (Item 1). Before the fix,
// `r.answer` and `r.thinking` accumulated turn-long without reset,
// so a message → tool_call → message sequence produced:
//   ● first_segment
//   → toolName
//   ● first_segment second_segment    (cumulative)
//   → toolName
//   ● first_segment second_segment third_segment   (cumulative)
//
// After the fix the `lastChunkKind` discriminator resets the buffer on
// every kind transition, so each ● line contains only its own segment.
//
// The harness uses a FakeMcodeAcpClient whose prompt() callback is
// invoked through the real runMcodeAcp / streamAcpPrompt pipeline,
// with the REAL chat-line.js#streamUpdateLine (no mock for it) so
// the same-prefix-replace behaviour is exercised end-to-end.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { setupMocks, absPath } from "../helpers/_setup.js";

class FakeMcodeAcpClient {
  static lastPromptCallback = null;
  static pendingResolve = null;
  constructor() {}
  async start() {}
  async newSession(_cwd) {
    return { sessionId: "mvs_fake_test", configOptions: [] };
  }
  async loadSession() {
    return { sessionId: "mvs_fake_test", configOptions: [] };
  }
  async request(method, _params) {
    if (method === "session/set_config_option") return {};
    return {};
  }
  prompt(_sessionId, _blocks, onChunk) {
    // Stash the onChunk callback so the test can drive the chunk
    // sequence from outside the stream. Returns a Promise that
    // resolves once the test is done feeding chunks.
    FakeMcodeAcpClient.lastPromptCallback = onChunk;
    return new Promise((resolve) => {
      FakeMcodeAcpClient.pendingResolve = () =>
        resolve({
          answer: null,
          thinking: null,
          stopReason: "end_turn",
          usage: null,
        });
    });
  }
  stop() {}
}

let mcodeAcp;
let sessions;
let stateBus;

before(async (t) => {
  // Mock acp.mjs FIRST so the SUT's `new McodeAcpClient()` imports
  // FakeMcodeAcpClient at module-load time. THEN mock the modules
  // setupMocks mocks — except skip setupMocks' default
  // `lib/mcode-acp.js` mock (it replaces runMcodeAcp with a no-op
  // stub). We pass a mcodeAcp override so the dispatch through
  // _mcodeAcpMock lands on the real runMcodeAcp — which then
  // calls FakeMcodeAcpClient.prompt().
  t.mock.module(absPath("../acp.mjs"), {
    namedExports: { McodeAcpClient: FakeMcodeAcpClient },
  });
  // Import AFTER the acp.mjs mock so the real runMcodeAcp sees
  // FakeMcodeAcpClient via its `import { McodeAcpClient } from
  // "../../acp.mjs"`.
  mcodeAcp = await import(absPath("lib/mcode-acp.js"));
  sessions = await import(absPath("lib/sessions.js"));
  // session-isolation/02 (run-mirror): stream writes land in the
  // per-(cid, owning sid) runChat buffer, not cs.chat — the harness
  // reads the routed lines through the same accessor the snapshots use.
  stateBus = await import(absPath("lib/state-bus.js"));
  const chatLine = await import(absPath("lib/chat-line.js"));
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({
        mcode: [],
        webui: [],
        fetchedAt: 0,
        source: "test",
      }),
    },
    // Wire _mcodeAcpMock.runMcodeAcp through to the real one so
    // the SUT actually drives streamAcpPrompt's chunk handler.
    mcodeAcp: {
      runMcodeAcp: (...args) => mcodeAcp.runMcodeAcp(...args),
      streamAcpPrompt: (...args) => mcodeAcp.streamAcpPrompt(...args),
    },
    // session-isolation/06: the cumulative bug can ONLY be observed
    // with the real chat-line.js#streamUpdateLine (same-prefix
    // replace); the push-every-time mock from setupMocks hides it.
    // We override it with the real module export.
    chatLine: {
      streamUpdateLine: (chat, prefix, text) =>
        chatLine.streamUpdateLine(chat, prefix, text),
    },
  });
});

/**
 * Drive one prompt through runMcodeAcp with the given chunk
 * sequence, then return the chat lines that streamUpdateLine wrote.
 */
async function runPrompt(chunks) {
  const cs = {
    model: { name: "minimax_api/MiniMax-M3" },
    workspace: { dir: "/tmp" },
    sessionId: null,
    mcodeSessionId: null,
    sessionTitle: "Untitled",
    chat: [],
    usage: {},
    context: { used: 0, limit: 0, percent: 0, tokens: 0 },
    running: { active: false },
  };
  sessions.clearActiveChild?.("cid-test");
  // Each test starts with a fresh FakeMcodeAcpClient state — clear
  // any leftover callback from the previous test so a stalled prompt
  // cannot reach this test's chunks.
  FakeMcodeAcpClient.lastPromptCallback = null;
  FakeMcodeAcpClient.pendingResolve = null;
  try {
    const p = mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs,
      cid: "cid-test",
      sessionId: null,
    });
    // Wait for the engine transport to start.
    for (let i = 0; i < 50 && !FakeMcodeAcpClient.lastPromptCallback; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!FakeMcodeAcpClient.lastPromptCallback) {
      throw new Error("prompt callback never registered");
    }
    // Feed the chunks in order, then resolve the prompt.
    const cb = FakeMcodeAcpClient.lastPromptCallback;
    for (const c of chunks) cb(c);
    if (FakeMcodeAcpClient.pendingResolve) {
      FakeMcodeAcpClient.pendingResolve();
    }
    // Wait for runMcodeAcp to settle.
    await p;
    // Force-clear any leftover timers / state so the watchdog cannot
    // keep the test runner alive past this test.
    cs.running = { active: false, lastDeltaAt: null };
    // session-isolation/02 (run-mirror): the stream writes went to the
    // runChat buffer keyed by (cid, engine sid) — this harness runs
    // runMcodeAcp directly (no handleSend finalize drain), so collect
    // the routed lines the way a view would see them: the viewed chat
    // plus the turn's buffered lines.
    const buffered =
      (cs.mcodeSessionId &&
        stateBus.runChatLinesFor("cid-test", cs.mcodeSessionId)) ||
      [];
    return [...(cs.chat || []), ...buffered].map((line) =>
      typeof line === "string" && line.endsWith(" ▍")
        ? line.slice(0, -2)
        : line,
    );
  } finally {
    sessions.clearActiveChild?.("cid-test");
    FakeMcodeAcpClient.lastPromptCallback = null;
    FakeMcodeAcpClient.pendingResolve = null;
  }
}

describe("streamAcpPrompt — per-segment accumulator reset (Item 1)", () => {
  test("message → tool_call → message → tool_call → message: each ● holds ONLY its own segment", async () => {
    const lines = await runPrompt([
      { kind: "message", text: "first " },
      { kind: "tool_call", update: { title: "list", rawInput: { path: "/a" } } },
      { kind: "tool_call", update: { status: "ok", output: "[]" } },
      { kind: "message", text: "second " },
      { kind: "tool_call", update: { title: "read", rawInput: { path: "/b" } } },
      { kind: "tool_call", update: { status: "ok", output: "x" } },
      { kind: "message", text: "third" },
    ]);

    const dotTexts = lines
      .filter((line) => typeof line === "string" && line.startsWith("● "))
      .map((line) => line.slice("● ".length));
    assert.deepEqual(
      dotTexts,
      ["first", "second", "third"],
      "each ● line holds ONLY its own segment, never the cumulative history",
    );
    // Defensive: explicit cumulative-render regression check.
    assert.equal(
      dotTexts[1].includes("first"),
      false,
      "second ● must not contain the first segment's text",
    );
    assert.equal(
      dotTexts[2].includes("first"),
      false,
      "third ● must not contain the first segment's text",
    );
    assert.equal(
      dotTexts[2].includes("second"),
      false,
      "third ● must not contain the second segment's text",
    );
  });

  test("single-segment streaming growth still appends within one ● line", async () => {
    // Streaming: same-kind chunks MUST accumulate within a single
    // line — that's the whole point of incremental updates — and
    // streamUpdateLine's same-prefix-replace keeps it as one row.
    // The fix must NOT regress this; the cross-segment reset in
    // Item 1 only fires when the kind changes (here all three
    // chunks are message).
    const lines = await runPrompt([
      { kind: "message", text: "alpha " },
      { kind: "message", text: "alpha bravo " },
      { kind: "message", text: "alpha bravo charlie" },
    ]);
    const dots = lines.filter(
      (line) => typeof line === "string" && line.startsWith("● "),
    );
    assert.equal(
      dots.length,
      1,
      "single-segment growth stays on one ● line (same-prefix replace)",
    );
    // The buffer accumulates across same-kind chunks (that IS
    // streaming growth), and trim() drops the trailing space.
    assert.equal(
      dots[0],
      "● alpha alpha bravo alpha bravo charlie",
      "the line carries the cumulative streaming text — the reset only fires on kind change",
    );
  });

  test("thought → message → thought: each ▲ / ● resets cleanly", async () => {
    const lines = await runPrompt([
      { kind: "thought", text: "thinking v1" },
      { kind: "message", text: "answer v1" },
      { kind: "thought", text: "thinking v2" },
      { kind: "message", text: "answer v2" },
    ]);
    const arrows = lines.filter(
      (line) => typeof line === "string" && line.startsWith("▲ "),
    );
    const dots = lines.filter(
      (line) => typeof line === "string" && line.startsWith("● "),
    );
    assert.equal(arrows.length, 2);
    assert.equal(arrows[0], "▲ thinking v1");
    assert.equal(
      arrows[1],
      "▲ thinking v2",
      "second ▲ must not contain the in-between message text",
    );
    assert.equal(dots.length, 2);
    assert.equal(dots[0], "● answer v1");
    assert.equal(
      dots[1],
      "● answer v2",
      "second ● must not contain the in-between thought text",
    );
  });
});