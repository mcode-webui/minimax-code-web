// webui/test/lib/acp-transport-answer.test.js
// session-isolation/07 — the transport's turn-long answer accumulator.
//
// Bug shape: acp.mjs#prompt accumulated result.answer / result.thinking
// across the WHOLE turn, while the live view (session-isolation/06's
// per-segment model) holds only the LAST segment. When the prompt
// settled, streamAcpPrompt copied the concatenation over its own
// per-segment value, so the [send] result log, the ● finalize rewrite,
// the no-usage token estimate and the empty-turn note all saw the
// turn-long text.
//
// Contract pinned here:
//   1. Transport: multi-segment turn → result.answer / result.thinking
//      carry the FINAL segment (same-kind chunks append — streaming
//      growth; a kind change resets), matching the live `●` / `▲` lines.
//   2. Integration: streamAcpPrompt's r.answer is the last segment, so
//      the no-usage token estimate is computed from the segment text.
//   3. Integration: empty-turn detection is unaffected — a turn that
//      ends with no message segment still produces the system note.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Isolation FIRST — lib/config.js resolves SESSIONS_DB from
// MCODE_WEBUI_DATA_DIR at import time.
const _tmpDataDir = mkdtempSync(join(tmpdir(), "webui-acp-answer-"));
process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;

const WEBUI_DIR = resolve(import.meta.dirname, "..", "..");
const SERVER_DIR = resolve(WEBUI_DIR, "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;
const absWebuiPath = (rel) => pathToFileURL(resolve(WEBUI_DIR, rel)).href;

// ------------------------------------------------------------------
// Part 1 — transport unit: drive acp.mjs#prompt without spawning a
// child. The constructor does not spawn (start() does); patching
// request() settles the prompt promise while the test feeds
// session/update events through the client's own EventEmitter.
// ------------------------------------------------------------------
const { McodeAcpClient } = await import(absWebuiPath("acp.mjs"));

const thought = (text) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const message = (text) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

function makeTransportClient() {
  const client = new McodeAcpClient({});
  client.request = async () => ({ stopReason: "end_turn", usage: null });
  return client;
}

describe("acp.mjs prompt accumulation — per-segment (session-isolation/07)", () => {
  test("multi-segment turn → result.answer is the FINAL segment, not the concatenation", async () => {
    const client = makeTransportClient();
    const chunks = [];
    const p = client.prompt("sid-1", "hi", (c) => chunks.push(c));
    client.emit("sessionUpdate", message("first segment "));
    client.emit("sessionUpdate", {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "read",
    });
    client.emit("sessionUpdate", message("second segment"));
    const r = await p;
    assert.equal(
      r.answer,
      "second segment",
      "result.answer must hold the last segment only",
    );
    assert.notEqual(
      r.answer,
      "first segment second segment",
      "the turn-long concatenation must be gone",
    );
    // onChunk passthrough is unchanged — the live view still sees every
    // chunk in order.
    assert.deepEqual(
      chunks.filter((c) => c.kind === "message").map((c) => c.text),
      ["first segment ", "second segment"],
    );
  });

  test("same-kind chunks append (streaming growth stays one segment)", async () => {
    const client = makeTransportClient();
    const p = client.prompt("sid-1", "hi");
    client.emit("sessionUpdate", message("alpha "));
    client.emit("sessionUpdate", message("alpha bravo "));
    client.emit("sessionUpdate", message("alpha bravo charlie"));
    const r = await p;
    assert.equal(r.answer, "alpha alpha bravo alpha bravo charlie");
  });

  test("a tool_update between message segments also starts a new segment", async () => {
    const client = makeTransportClient();
    const p = client.prompt("sid-1", "hi");
    client.emit("sessionUpdate", message("before tool "));
    client.emit("sessionUpdate", {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "read",
    });
    client.emit("sessionUpdate", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    client.emit("sessionUpdate", message("after tool"));
    const r = await p;
    assert.equal(r.answer, "after tool");
  });

  test("mid-segment usage / session_info events do NOT reset (acceptance alignment)", async () => {
    // Acceptance drift pin, both directions: the transport's reset set
    // must match the server's lastChunkKind rule exactly.
    //   - tool_call-class events (chat-line-breaking) DO reset;
    //   - non-rendering events that can interleave MID-segment
    //     (usage_update, session_info_update, plan_update, ...) must
    //     NOT — an early reset would truncate result.answer before
    //     streamAcpPrompt's settle merge consumes it.
    const client = makeTransportClient();
    const p = client.prompt("sid-1", "hi");
    client.emit("sessionUpdate", message("kept "));
    client.emit("sessionUpdate", {
      sessionUpdate: "usage_update",
      used: 100,
      size: 1000,
    });
    client.emit("sessionUpdate", message("across usage "));
    client.emit("sessionUpdate", {
      sessionUpdate: "session_info_update",
      keys: "x",
    });
    client.emit("sessionUpdate", { sessionUpdate: "plan_update", planId: "p1" });
    client.emit("sessionUpdate", message("and plan"));
    const r = await p;
    assert.equal(
      r.answer,
      "kept across usage and plan",
      "non-rendering events must not break the segment",
    );
  });

  test("thought / message resets mirror the live ▲ / ● discriminator", async () => {
    const client = makeTransportClient();
    const p = client.prompt("sid-1", "hi");
    client.emit("sessionUpdate", thought("thinking v1"));
    client.emit("sessionUpdate", message("answer v1"));
    client.emit("sessionUpdate", thought("thinking v2"));
    client.emit("sessionUpdate", message("answer v2"));
    const r = await p;
    assert.equal(r.thinking, "thinking v2");
    assert.equal(r.answer, "answer v2");
  });
});

// ------------------------------------------------------------------
// Part 2 — integration through the real streamAcpPrompt: the settle
// path (empty-turn note, no-usage token estimate, r.answer) consumes
// the segment semantics end-to-end.
// ------------------------------------------------------------------
class FakeMcodeAcpClient {
  static sessionCounter = 0;
  static lastOnChunk = null;
  static pending = [];

  static reset() {
    this.sessionCounter = 0;
    this.lastOnChunk = null;
    this.pending = [];
  }

  static emit(chunk) {
    const cb = this.lastOnChunk;
    if (!cb) throw new Error("no live prompt callback");
    cb(chunk);
  }

  static release(extra = {}) {
    const resolveFn = this.pending.shift();
    if (resolveFn) {
      resolveFn({
        answer: null,
        thinking: null,
        stopReason: "end_turn",
        usage: null,
        ...extra,
      });
    }
  }

  constructor() {}
  async start() {}
  async newSession() {
    FakeMcodeAcpClient.sessionCounter += 1;
    return {
      sessionId: `mvs_fake_${FakeMcodeAcpClient.sessionCounter}`,
      configOptions: [],
    };
  }
  async loadSession(sessionId) {
    return { sessionId, configOptions: [] };
  }
  async request() {
    return {};
  }
  prompt(_sessionId, _blocks, onChunk) {
    FakeMcodeAcpClient.lastOnChunk = onChunk;
    return new Promise((resolveFn) => {
      FakeMcodeAcpClient.pending.push((extra) => resolveFn(extra));
    });
  }
  stop() {}
}

let mcodeAcp;
let sessions;
let stateBus;

before(async (t) => {
  t.mock.module(absWebuiPath("acp.mjs"), {
    namedExports: { McodeAcpClient: FakeMcodeAcpClient },
  });
  t.mock.module(absPath("lib/acp-client.js"), {
    namedExports: {
      getCachedMcodeCommands: () => [],
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => null,
      getMcodeSessionsStaleSync: () => null,
      getMcodeSessionTitle: async () => null,
      deleteMcodeSessionFromDb: () => ({ ok: true }),
      getMcodeAcpClient: async () => null,
      listAllMcodeSessions: async () => [],
      getMcodeServerInfo: () => null,
      invalidateMcodeSessionsCache: () => {},
      shutdownMcodeAcpSingleton: () => {},
      dropMcodeSessionFromCache: () => {},
      ensureMcodeCommands: async () => ({
        mcode: [], webui: [], fetchedAt: 0, source: "test-default",
      }),
    },
  });
  t.mock.module(absPath("lib/mavis-usage.js"), {
    namedExports: {
      getMavisTokenUsage: async () => null,
      getMavisTokenUsageModel: async () => null,
      applyMavisUsageToCs: async () => false,
    },
  });
  t.mock.module(absPath("lib/slash.js"), {
    namedExports: {
      handleLocalSlash: async () => ({ handled: false, continueMcode: false }),
      handleCmdCommand: async () => ({ ok: true }),
      matchSlash: (content) => {
        const m = content.match(/^\/([a-zA-Z][\w-]*)\b\s*(.*)/);
        if (!m) return null;
        return { cmd: m[1], rest: m[2] || "" };
      },
    },
  });
  mcodeAcp = await import(absPath("lib/mcode-acp.js"));
  sessions = await import(absPath("lib/sessions.js"));
  stateBus = await import(absPath("lib/state-bus.js"));
});

beforeEach(() => {
  sessions._resetSessionsCacheForTests();
  FakeMcodeAcpClient.reset();
});

after(() => {
  try {
    rmSync(_tmpDataDir, { recursive: true, force: true });
  } catch {}
});

function makeCs(cid) {
  const cs = {
    model: { name: "minimax_api/MiniMax-M3" },
    workspace: { dir: "/tmp" },
    sessionId: null,
    mcodeSessionId: null,
    sessionTitle: "Untitled",
    chat: ["› hi"],
    usage: {},
    context: { used: 0, limit: 0, percent: 0, tokens: 0 },
    running: { active: false },
  };
  return cs;
}

/** Drive one prompt through the real runMcodeAcp; returns { r, cs }. */
async function runPrompt({ chunks, response }) {
  const cid = "cid-acp-answer";
  const cs = makeCs(cid);
  sessions.clearActiveChild?.(cid);
  FakeMcodeAcpClient.lastOnChunk = null;
  FakeMcodeAcpClient.pending = [];
  try {
    const p = mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs,
      cid,
      sessionId: null,
    });
    for (let i = 0; i < 50 && !FakeMcodeAcpClient.lastOnChunk; i++) {
      await new Promise((r2) => setTimeout(r2, 10));
    }
    if (!FakeMcodeAcpClient.lastOnChunk) {
      throw new Error("prompt callback never registered");
    }
    for (const c of chunks) FakeMcodeAcpClient.emit(c);
    FakeMcodeAcpClient.release(response);
    const r = await p;
    return { r, cs };
  } finally {
    sessions.clearActiveChild?.(cid);
    FakeMcodeAcpClient.lastOnChunk = null;
    FakeMcodeAcpClient.pending = [];
  }
}

describe("streamAcpPrompt settle path — segment semantics (session-isolation/07)", () => {
  test("multi-segment turn: r.answer is the last segment; token estimate uses segment text", async () => {
    const { r, cs } = await runPrompt({
      chunks: [
        { kind: "thought", text: "abc" }, // 3 chars
        { kind: "message", text: "defg" }, // 4 chars — final segment
        { kind: "tool_call", update: { title: "read", rawInput: { path: "/a" } } },
      ],
      response: { stopReason: "end_turn", usage: null },
    });
    assert.equal(
      r.answer,
      "defg",
      "r.answer must be the final segment after settle",
    );
    assert.equal(r.thinking, "abc");
    // No-usage fallback estimate: outText = last thinking + last answer
    // ("abc" + "defg" = 7 chars → ceil(7/3) = 3), user line "› hi"
    // (4 chars → ceil(4/3) = 2). Under the old turn-long accumulator
    // this number silently grew with every extra segment.
    assert.equal(cs.context.estimated, true);
    assert.equal(cs.context.tokens, 5);
    // No empty-turn note: the final segment had text.
    const sid = cs.mcodeSessionId;
    const buf = stateBus.runChatLinesFor("cid-acp-answer", sid) || [];
    assert.ok(
      buf.every((l) => !String(l).startsWith("! ")),
      "no empty-turn note when the final segment has text",
    );
  });

  test("empty-turn detection unaffected: thought-only turn produces the system note", async () => {
    const { r, cs } = await runPrompt({
      chunks: [{ kind: "thought", text: "budget consumed" }],
      response: { stopReason: "max_tokens", usage: null },
    });
    assert.equal(r.answer, null, "no message segment → r.answer stays null");
    const sid = cs.mcodeSessionId;
    const buf = stateBus.runChatLinesFor("cid-acp-answer", sid) || [];
    const note = buf.find((l) => typeof l === "string" && l.startsWith("! "));
    assert.ok(note, "the empty-turn note must land in the run buffer");
    assert.match(note, /max_tokens/);
  });
});
