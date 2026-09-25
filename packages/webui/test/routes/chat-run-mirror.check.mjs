// webui/test/routes/chat-run-mirror.check.mjs
// Route-level contract test for the run-mirror session isolation
// (session-isolation/02).
//
// Bug shape (acceptance evidence): mid-run the user switches from
// session T1 to session T2 in the same browser (same cid). The
// engine's streamed lines used to be written into `cs.chat` — the
// VIEWED session's chat — so T2's live view filled with T1's tool and
// answer lines, and the turn-end persistence wrote T1's content (and
// engine binding) into T2's record.
//
// The fix: every stream write lands in a per-(cid, owning engine
// session) runChat buffer; the wire snapshots re-attach the buffer for
// the OWNING view only (state-bus.snapshotViewFields); the route's
// finalize drain flushes the buffer into cs.chat when the user still
// views the owning session, or into the owning session's persisted
// record (appendChatToSession) when they switched away.
//
// Like chat-first-turn-session-guard.check.mjs, this file mocks ONLY
// the ACP transport (acp.mjs) and the heavy peripherals, and runs the
// REAL chat.js → runMcodeAcp → sessions.js → state-bus chain plus the
// REAL switch route — the switch is performed by handleSwitchSession
// itself, exactly as the browser triggers it.
//
// Contract pinned here:
//   1. Mid-run switch away → the switched-to view receives no lines of
//      the running session (pushed snapshot chat + running indicator),
//      while the buffer keeps accumulating the running session's lines.
//   2. Switch back mid-run → the view shows the record lines plus the
//      buffered lines so far (switch response and SSE snapshot).
//   3. Finalize while still viewing → full turn lands in cs.chat and
//      in the OWNING record; buffer drained; no duplicate ● line.
//   4. Finalize while switched away → the full turn lands in the
//      OWNING record only; the viewed session's cs.chat and record stay
//      clean; cs.mcodeSessionId is NOT re-pointed at the run's engine
//      sid (the finalize clobber that made T2 inherit T1's engine
//      session).
//   5. First-turn draft promotion under a pre-bind switch: the DRAFT
//      record (captured owning webui id) is promoted and receives the
//      turn — never the record the user switched to.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Isolation FIRST — lib/config.js resolves SESSIONS_DB / UPLOAD_DIR from
// MCODE_WEBUI_DATA_DIR at import time. Neither this check nor the
// operator's real ~/.mcode-webui may see the other.
const _tmpDataDir = mkdtempSync(join(tmpdir(), "webui-run-mirror-"));
process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpDataDir, "events.ndjson");

const SERVER_DIR = resolve(import.meta.dirname, "..", "..", "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

// ------------------------------------------------------------------
// Fake ACP transport — same surface as the guard test's, plus:
//   - static emit(chunk): drives the live prompt's onChunk callback
//     under test control (streamed lines);
//   - a gateable newSession: the pre-bind switch test parks the turn
//     BEFORE the engine session id exists.
// ------------------------------------------------------------------
class FakeMcodeAcpClient {
  static instances = [];
  static sessionCounter = 0;
  static pending = [];
  static lastOnChunk = null;
  static newSessionGate = null; // fn set → newSession awaits gate()

  static reset() {
    this.instances = [];
    this.sessionCounter = 0;
    this.pending = [];
    this.lastOnChunk = null;
    this.newSessionGate = null;
  }

  /** Feed one stream chunk into the live prompt callback. */
  static emit(chunk) {
    const cb = this.lastOnChunk;
    if (!cb) throw new Error("no live prompt callback");
    cb(chunk);
  }

  /** Release the oldest parked prompt (FIFO — matches claim order). */
  static release(extra = {}) {
    const resolveFn = this.pending.shift();
    if (resolveFn) {
      resolveFn({
        answer: "ok",
        thinking: null,
        stopReason: "end_turn",
        usage: null,
        ...extra,
      });
    }
  }

  constructor() {
    FakeMcodeAcpClient.instances.push(this);
  }
  async start() {}
  async loadSession(sessionId) {
    return { sessionId, configOptions: [] };
  }
  async newSession() {
    if (FakeMcodeAcpClient.newSessionGate) {
      await FakeMcodeAcpClient.newSessionGate();
    }
    FakeMcodeAcpClient.sessionCounter += 1;
    return {
      sessionId: `mvs_fake_${FakeMcodeAcpClient.sessionCounter}`,
      configOptions: [],
    };
  }
  async request() {
    return {};
  }
  prompt(sessionId, _blocks, onChunk) {
    FakeMcodeAcpClient.lastOnChunk = onChunk;
    return new Promise((resolveFn) => {
      FakeMcodeAcpClient.pending.push((extra) => {
        resolveFn({
          answer: "ok",
          thinking: null,
          stopReason: "end_turn",
          usage: null,
          ...extra,
        });
      });
    });
  }
  stop() {}
}

// Register the mock modules. Must run before the SUTs are imported.
async function setupMocks(t) {
  t.mock.module(absPath("../acp.mjs"), {
    namedExports: { McodeAcpClient: FakeMcodeAcpClient },
  });
  t.mock.module(absPath("lib/acp-client.js"), {
    namedExports: {
      getCachedMcodeCommands: () => [],
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => null,
      getMcodeSessionsStaleSync: () => null,
      getMcodeSessionTitle: async () => "Engine title",
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
}

let handleSend;
let handleSwitchSession;
let sb; // real state-bus
let sessions; // real sessions lib (redirected store)
let alerts;

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}

function fakeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
}

// Fake SSE client — lets the test observe the exact snapshot bytes the
// server pushes for this cid (peekLastPushed returns the last payload).
function fakeSse() {
  return { write() {}, end() {} };
}

function lastSnapshot(cid) {
  const raw = sb.peekLastPushed(cid);
  return raw ? JSON.parse(raw) : null;
}

async function waitFor(fn, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const WS = join(_tmpDataDir, "ws");

function makeClient(cid, { sessionId = null, mcodeSessionId = null } = {}) {
  const cs = sb.makeClientState();
  cs.workspace = { dir: WS, branch: null, tree: null };
  cs.sessionId = sessionId;
  cs.mcodeSessionId = mcodeSessionId;
  cs.chat = [];
  sb.clients.set(cid, cs);
  sb.setSseClient(cid, fakeSse());
  return cs;
}

function storeRecord(id, chat = []) {
  const all = sessions.loadSessions();
  all.unshift({
    id,
    title: id === "sess-B" ? "Session B" : "New session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chat,
    workspace: WS,
  });
  sessions.saveSessions(all);
  return all.find((s) => s.id === id);
}

function recordBy(id) {
  return sessions.loadSessions().find((s) => s && s.id === id) || null;
}

// §§ marker lines carry a variable duration — filter them for chat
// assertions that pin stable lines only.
const stable = (chat) =>
  (chat || []).filter((line) => !String(line).startsWith("§§"));

before(async (t) => {
  await setupMocks(t);
  sb = await import(absPath("lib/state-bus.js"));
  sessions = await import(absPath("lib/sessions.js"));
  alerts = await import(absPath("lib/alerts.js"));
  const chatMod = await import(absPath("routes/chat.js"));
  handleSend = chatMod.handleSend;
  const sessionsRoute = await import(absPath("routes/sessions.js"));
  handleSwitchSession = sessionsRoute.handleSwitchSession;
});

beforeEach(() => {
  sb.clients.clear();
  sb.resetCoalesceState();
  try {
    rmSync(join(_tmpDataDir, "sessions.json"), { force: true });
  } catch {}
  sessions._resetSessionsCacheForTests();
  alerts._resetForTests();
  FakeMcodeAcpClient.reset();
});

after(() => {
  try {
    rmSync(_tmpDataDir, { recursive: true, force: true });
  } catch {}
});

/**
 * Shared fixture: one cid bound to an existing session A (one
 * completed turn already persisted), and a second session B record to
 * switch to. Returns everything the cases need.
 */
async function setupTwoSessions(cid) {
  const cs = makeClient(cid, { sessionId: "sess-A" });
  storeRecord("sess-A", []);
  storeRecord("sess-B", []);
  // Turn 1 — completes immediately; promotes the A record to the
  // engine identity (id → mvs_fake_1) and persists ["› hello", "● ok"].
  const res1 = fakeRes();
  const turn1 = handleSend(fakeReq({ content: "hello" }), res1, { cs, cid });
  await waitFor(() => cs.mcodeSessionId, "turn 1 to bind the engine sid");
  FakeMcodeAcpClient.release();
  await turn1;
  await waitFor(() => sb.activeRunCount() === 0, "turn 1 to drain");
  const sidA = cs.mcodeSessionId;
  assert.deepEqual(stable(cs.chat), ["› hello", "● ok"]);
  assert.equal(recordBy(sidA).mcodeSessionId, sidA);
  return { cs, cid, sidA };
}

// Stream a recognizable multi-line turn into the live prompt, step by
// step (the caller asserts on intermediate buffer states between steps).
function emitThought() {
  FakeMcodeAcpClient.emit({ kind: "thought", text: "pondering" });
}
function emitToolAndAnswer() {
  FakeMcodeAcpClient.emit({ kind: "tool_call", update: { toolCallId: "tc-1", name: "Bash", rawInput: { cmd: "ls" } } });
  FakeMcodeAcpClient.emit({
    kind: "tool_update",
    update: { toolCallId: "tc-1", status: "completed", rawOutput: { content: [{ type: "text", text: "file.txt" }] } },
  });
  FakeMcodeAcpClient.emit({ kind: "message", text: "part one" });
}

describe("run-mirror — mid-run switch keeps views and records isolated", () => {
  test("still viewing: live snapshot merges the buffer; finalize drains into cs.chat and the owning record", async () => {
    const cid = "cid-mirror-stay";
    const { cs, sidA } = await setupTwoSessions(cid);

    const res2 = fakeRes();
    const turn2 = handleSend(fakeReq({ content: "run A2" }), res2, { cs, cid });
    await waitFor(
      () => FakeMcodeAcpClient.pending.length === 1,
      "turn 2 prompt to park",
    );

    emitThought();
    let buf = sb.runChatLinesFor(cid, sidA);
    assert.ok(buf, "buffer exists for the owning (cid, sid)");
    assert.equal(buf[0], "▲ pondering ▍");

    emitToolAndAnswer();
    buf = sb.runChatLinesFor(cid, sidA);
    assert.equal(buf[0], "▲ pondering", "message stream strips the ▲ cursor");
    assert.equal(buf[1], "→ Bash  {\"cmd\":\"ls\"}");
    assert.ok(buf.includes("  [completed]"));
    assert.ok(buf.includes("  file.txt"));
    assert.match(buf[buf.length - 1], /^● part one/);

    // Live view (owning session on screen): snapshot chat = record chat
    // + buffer, and the run indicator is on.
    sb.pushStateFor(cid);
    const snap = lastSnapshot(cid);
    assert.equal(snap.running.active, true);
    assert.equal(snap.context.thinkingStatus, "Running");
    assert.deepEqual(
      stable(snap.chat).slice(0, 2),
      ["› hello", "● ok"],
      "record lines come first",
    );
    assert.ok(snap.chat.some((l) => String(l).startsWith("● part one")));

    // Switch away and BACK mid-run: the owning view shows the buffered
    // lines so far (switch response) and keeps its running indicator
    // even though the switch's resetContext healed cs to idle.
    await handleSwitchSession(fakeReq({ id: "sess-B" }), fakeRes(), { cs, cid });
    assert.equal(lastSnapshot(cid).running.active, false);
    await handleSwitchSession(fakeReq({ id: sidA }), fakeRes(), { cs, cid });
    const backSnap = lastSnapshot(cid);
    assert.equal(
      backSnap.running.active,
      true,
      "owning view keeps its running indicator after switch-back",
    );
    // base (3 persisted lines) + the 6 buffered stream lines so far
    assert.equal(backSnap.chat.length, 9);
    assert.deepEqual(
      stable(backSnap.chat).slice(0, 3),
      ["› hello", "● ok", "› run A2"],
    );
    assert.ok(backSnap.chat.some((l) => String(l).startsWith("● part one")));

    FakeMcodeAcpClient.release({ answer: "final answer" });
    await turn2;
    await waitFor(() => sb.activeRunCount() === 0, "turn 2 to drain");

    // View: full turn, exactly one final ● line, no leaked ▍ cursor.
    const view = stable(cs.chat);
    assert.deepEqual(view, [
      "› hello",
      "● ok",
      "› run A2",
      "▲ pondering",
      "→ Bash  {\"cmd\":\"ls\"}",
      "  [completed]",
      "  file.txt",
      "● final answer",
    ]);
    assert.equal(
      cs.chat.filter((l) => String(l).startsWith("● ")).length,
      2,
      "no duplicate ● line",
    );
    assert.ok(cs.chat.every((l) => !String(l).endsWith("▍")), "cursors stripped");

    // Record: identical content; buffer fully drained.
    assert.deepEqual(stable(recordBy(sidA).chat), view);
    assert.equal(sb.runChatLinesFor(cid, sidA), null);
    assert.equal(sb.hasRunChat(cid, sidA), false);

    // The other session's record never saw any of it.
    assert.deepEqual(recordBy("sess-B").chat, []);
  });

  test("switch away mid-run: other view stays clean; finalize writes the OWNING record and never re-points the viewed session", async () => {
    const cid = "cid-mirror-switch";
    const { cs, sidA } = await setupTwoSessions(cid);

    const res2 = fakeRes();
    const turn2 = handleSend(fakeReq({ content: "run A2" }), res2, { cs, cid });
    await waitFor(() => FakeMcodeAcpClient.pending.length === 1, "prompt parked");
    emitThought();
    emitToolAndAnswer();

    // Mid-run switch to B — through the REAL switch route.
    const swRes = fakeRes();
    await handleSwitchSession(fakeReq({ id: "sess-B" }), swRes, { cs, cid });
    assert.equal(cs.sessionId, "sess-B");
    assert.equal(cs.mcodeSessionId, null);

    // B's view: no A lines, no running claim, idle thinking status.
    const snap = lastSnapshot(cid);
    assert.equal(snap.sessionId, "sess-B");
    assert.deepEqual(snap.chat, [], "T2 view must not contain T1 lines");
    assert.equal(snap.running.active, false, "T2 indicator idle");
    assert.equal(snap.context.thinkingStatus, "Idle");

    // The buffer keeps accumulating for the OWNING session.
    FakeMcodeAcpClient.emit({ kind: "message", text: " continued" });
    const buf = sb.runChatLinesFor(cid, sidA);
    assert.match(buf[buf.length - 1], /^● part one continued/);

    // Finalize while viewing B.
    FakeMcodeAcpClient.release({ answer: "switched answer" });
    await turn2;
    await waitFor(() => sb.activeRunCount() === 0, "turn to drain");

    // B's live view untouched.
    assert.deepEqual(cs.chat, []);
    assert.equal(cs.mcodeSessionId, null, "viewed session keeps its own binding");
    // B's record untouched.
    assert.deepEqual(recordBy("sess-B").chat, []);

    // A's record received the full turn, including the final ● line.
    const recA = stable(recordBy(sidA).chat);
    assert.deepEqual(recA, [
      "› hello",
      "● ok",
      "› run A2",
      "▲ pondering",
      "→ Bash  {\"cmd\":\"ls\"}",
      "  [completed]",
      "  file.txt",
      "● switched answer",
    ]);
    // Binding + buffer finalize correctly on the owning side.
    assert.equal(recordBy(sidA).mcodeSessionId, sidA);
    assert.equal(sb.runChatLinesFor(cid, sidA), null);

    // Switching back shows the full conversation.
    const backRes = fakeRes();
    await handleSwitchSession(fakeReq({ id: sidA }), backRes, { cs, cid });
    assert.equal(cs.sessionId, sidA);
    assert.deepEqual(stable(cs.chat), recA);
  });

  test("first turn on a draft with a pre-bind switch: the DRAFT record is promoted and receives the turn, not the switched-to session", async () => {
    const cid = "cid-draft-switch";
    let releaseNewSession;
    FakeMcodeAcpClient.newSessionGate = () =>
      new Promise((r) => {
        releaseNewSession = r;
      });

    const cs = makeClient(cid); // brand-new: no sessionId, no sid
    storeRecord("sess-B", []);

    const res1 = fakeRes();
    const turn1 = handleSend(fakeReq({ content: "first!" }), res1, { cs, cid });
    // handleSend created the draft record; the turn is parked BEFORE the
    // engine session id exists (inside session/new).
    await waitFor(() => cs.sessionId, "draft record created");
    const draftId = cs.sessionId;
    assert.ok(draftId && draftId !== "sess-B");
    await waitFor(() => releaseNewSession, "turn parked inside session/new");

    // User switches away BEFORE the bind ran.
    await handleSwitchSession(fakeReq({ id: "sess-B" }), fakeRes(), { cs, cid });
    assert.equal(cs.sessionId, "sess-B");
    assert.equal(cs.mcodeSessionId, null);

    releaseNewSession();

    // The DRAFT record (found via its preserved `›` line) got the engine
    // binding and was promoted (id = mvs sid); the switched-to record was
    // NOT renamed, merged, or bound.
    const promoted = await waitFor(
      () =>
        sessions
          .loadSessions()
          .find(
            (s) =>
              s &&
              s.mcodeSessionId &&
              s.mcodeSessionId === s.id &&
              Array.isArray(s.chat) &&
              s.chat.includes("› first!"),
          ) || null,
      "draft record promoted to the engine identity",
    );
    assert.ok(promoted.id.startsWith("mvs_fake_"));
    assert.deepEqual(stable(promoted.chat), ["› first!"]);
    assert.equal(recordBy(draftId), null, "the uuid draft is gone (promoted)");
    assert.deepEqual(recordBy("sess-B").chat, []);
    assert.equal(recordBy("sess-B").mcodeSessionId, undefined, "B unbound");

    // Stream lines land in the buffer keyed by the NEW engine sid, and
    // the promoted record is untouched until finalize.
    await waitFor(() => FakeMcodeAcpClient.pending.length === 1, "prompt parked");
    FakeMcodeAcpClient.emit({ kind: "message", text: "draft answer" });
    assert.ok(
      sb.runChatLinesFor(cid, promoted.mcodeSessionId),
      "buffer keyed by the real engine sid",
    );

    FakeMcodeAcpClient.release({ answer: "draft answer" });
    await turn1;
    await waitFor(() => sb.activeRunCount() === 0, "turn to drain");

    // Turn persisted to the OWNING (promoted draft) record only.
    assert.deepEqual(stable(promoted.chat), ["› first!", "● draft answer"]);
    assert.deepEqual(cs.chat, [], "B's live view still clean");
    assert.equal(cs.sessionId, "sess-B");
    assert.equal(cs.mcodeSessionId, null, "B's cs never inherited the engine sid");
    assert.deepEqual(recordBy("sess-B").chat, []);
    assert.equal(sb.runChatLinesFor(cid, promoted.mcodeSessionId), null);
  });
});
