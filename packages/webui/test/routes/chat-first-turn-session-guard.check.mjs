// webui/test/routes/chat-first-turn-session-guard.check.mjs
// Route-level contract test for the FIRST-TURN session-busy guard.
//
// Reproduction (acceptance evidence, /tmp/accept-session-isolation/):
// during a brand-new session's first turn, a second window (a different
// cid that had already learned the new engine session id — sidebar switch,
// or restoreLatestSession after the draft was promoted) sent to the same
// session and got HTTP 200. `handleSend` claimed the run with
// `beginRun(cid, cs.mcodeSessionId)` while `cs.mcodeSessionId` was still
// null, so `runsBySid` never guarded that session; the engine then
// rejected the duplicate prompt ("Session already has an active Turn")
// and the message was silently dropped.
//
// The fix backfills the run registry mid-turn (`updateRunSid`) at the
// point the turn's engine session id is determined inside runMcodeAcp —
// which is why this file mocks ONLY the ACP transport (acp.mjs) and the
// heavy peripherals (acp-client / mavis-usage / slash), and runs the REAL
// chat.js → runMcodeAcp → sessions.js → state-bus chain. Unlike
// chat-failed-send.check.mjs (which mocks mcode-acp.js away and therefore
// cannot exercise this hook), the sid assignment and the backfill happen
// exactly as they do in production.
//
// Contract pinned here:
//   1. First turn in flight → a second window on the same brand-new
//      session gets 409 {reason: "session-busy"} (not a 200 ack), and
//      may send again once the first turn ends.
//   2. Regression: normal multi-turn on one cid still works.
//   3. Regression: cross-cid parallel turns on DIFFERENT sessions are
//      not blocked and each turn gets its own engine session.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Isolation FIRST — lib/config.js resolves SESSIONS_DB / UPLOAD_DIR from
// MCODE_WEBUI_DATA_DIR at import time, and lib/events.js resolves the
// audit-log path per append (alerts audit-writes on failed sends). Neither
// this check nor the operator's real ~/.mcode-webui may see the other.
const _tmpDataDir = mkdtempSync(join(tmpdir(), "webui-first-turn-guard-"));
process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpDataDir, "events.ndjson");

const SERVER_DIR = resolve(import.meta.dirname, "..", "..", "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

// ------------------------------------------------------------------
// Fake ACP transport. The real McodeAcpClient spawns the mcode engine;
// this one fakes the exact surface runMcodeAcp uses (start / newSession /
// loadSession / request / prompt / stop) and parks each prompt promise in
// a FIFO queue until the test releases it, so the "turn in flight"
// window is deterministic even with concurrent turns.
// ------------------------------------------------------------------
class FakeMcodeAcpClient {
  static instances = [];
  static sessionCounter = 0;
  static lastPromptSid = null;
  static pending = [];

  static reset() {
    this.instances = [];
    this.sessionCounter = 0;
    this.lastPromptSid = null;
    this.pending = [];
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
    // Mirror the real engine: an existing session loads and prompts on it
    // (a throw here would send runMcodeAcp down its fresh-session
    // fallback path instead).
    return { sessionId, configOptions: [] };
  }
  async newSession() {
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
    FakeMcodeAcpClient.lastPromptSid = sessionId;
    return new Promise((resolveFn) => {
      FakeMcodeAcpClient.pending.push((extra) => {
        // Mirror the engine's message stream: streamAcpPrompt writes the
        // live `● ` chat line from this callback, and the route's success
        // path then updates THAT line instead of the previous turn's.
        try {
          onChunk({ kind: "message", text: "ok" });
        } catch {}
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

// Register the mock modules. Must run before chat.js is imported (its
// static imports bind at first dynamic import of the SUT).
async function setupFirstTurnMocks(t) {
  // The engine transport — replaced wholesale by FakeMcodeAcpClient.
  t.mock.module(absPath("../acp.mjs"), {
    namedExports: {
      McodeAcpClient: FakeMcodeAcpClient,
    },
  });
  // acp-client.js — consumers in this graph: state-bus.js, mcode-acp.js,
  // mcode-rpc.js. Full named-export coverage (a missing export fails the
  // SUT import closed — see test/helpers/_setup.js notes).
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
  // mavis-usage.js — the real one spawns the sqlite3 CLI on finalize's
  // 400 ms follow-up timer; stub it out.
  t.mock.module(absPath("lib/mavis-usage.js"), {
    namedExports: {
      getMavisTokenUsage: async () => null,
      getMavisTokenUsageModel: async () => null,
      applyMavisUsageToCs: async () => false,
    },
  });
  // slash.js — pulls interaction/commands.js + authorize.js; locally
  // handled commands are out of scope here, everything falls through to
  // the engine transport.
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

// Poll until fn() returns a truthy value — the turn's sid backfill happens
// after the (async) session/new inside the in-flight handleSend.
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

// finalize() appends a `§§ processed_duration=Nms` marker line whose
// duration varies; strip it so chat assertions pin only the stable lines.
function chatLines(cs) {
  return cs.chat.filter((line) => !String(line).startsWith("§§"));
}

function makeClient(cid, { mcodeSessionId = null } = {}) {
  const cs = sb.makeClientState();
  cs.workspace = { dir: WS, branch: null, tree: null };
  cs.mcodeSessionId = mcodeSessionId;
  cs.chat = [];
  sb.clients.set(cid, cs);
  return cs;
}

before(async (t) => {
  await setupFirstTurnMocks(t);
  sb = await import(absPath("lib/state-bus.js"));
  sessions = await import(absPath("lib/sessions.js"));
  alerts = await import(absPath("lib/alerts.js"));
  const chatMod = await import(absPath("routes/chat.js"));
  handleSend = chatMod.handleSend;
});

beforeEach(() => {
  sb.clients.clear();
  sb.resetCoalesceState();
  // Fresh redirected sessions store per case.
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

describe("POST /api/send — first-turn session-busy guard", () => {
  test("first turn in flight: second window on the same brand-new session gets 409 session-busy", async () => {
    const cidA = "cid-A-first-turn";
    const cidB = "cid-B-second-window";
    const csA = makeClient(cidA);

    // Window A sends the first message of a brand-new session. Fire and
    // forget — the route acks 200 and the turn runs asynchronously.
    const resA = fakeRes();
    const turnA = handleSend(fakeReq({ content: "hello" }), resA, {
      cs: csA,
      cid: cidA,
    });

    // Mid-turn: the engine session came into existence, and the run
    // registry must now claim it (the backfill under test).
    const sid = await waitFor(
      () => sb.getRunForCid(cidA) && sb.getRunForCid(cidA).sid,
      "run registry to carry the first turn's engine sid",
    );
    assert.match(sid, /^mvs_fake_/);
    assert.equal(csA.mcodeSessionId, sid, "cs.mcodeSessionId bound mid-turn");

    // Window B: a DIFFERENT cid already bound to that same brand-new
    // session (sidebar switch / restore after draft promotion).
    const csB = makeClient(cidB, { mcodeSessionId: sid });
    const resB = fakeRes();
    await handleSend(fakeReq({ content: "me too" }), resB, {
      cs: csB,
      cid: cidB,
    });

    assert.equal(resB._status, 409, "the duplicate send must be refused");
    const body = JSON.parse(resB._body);
    assert.equal(body.reason, "session-busy");
    assert.equal(body.ok, false);
    assert.equal(
      sb.activeRunCount(),
      1,
      "the refused send must not claim a slot",
    );
    // The refused send must not have touched B's chat (409 answers before
    // the fire-and-forget section — no silent partial state).
    assert.deepEqual(chatLines(csB), []);

    // Window A's turn completes and releases the session.
    FakeMcodeAcpClient.release();
    await turnA;
    assert.equal(resA._status, 200);
    await waitFor(() => sb.activeRunCount() === 0, "run registry to drain");
    assert.equal(sb.getRunForCid(cidA), null);

    // Now B may take the session, and continues the SAME engine session.
    const resB2 = fakeRes();
    const turnB2 = handleSend(fakeReq({ content: "my turn now" }), resB2, {
      cs: csB,
      cid: cidB,
    });
    assert.equal(resB2._status, 200);
    await waitFor(
      () => FakeMcodeAcpClient.pending.length === 1,
      "B's prompt to park in the fake transport",
    );
    FakeMcodeAcpClient.release();
    await turnB2;
    assert.equal(
      FakeMcodeAcpClient.lastPromptSid,
      sid,
      "B continues the SAME engine session",
    );
    assert.equal(sb.activeRunCount(), 0);
  });

  test("regression: normal multi-turn on one cid still works", async () => {
    const cid = "cid-multi-turn";
    const cs = makeClient(cid);

    const res1 = fakeRes();
    const turn1 = handleSend(fakeReq({ content: "first" }), res1, { cs, cid });
    const sid = await waitFor(
      () => cs.mcodeSessionId,
      "first turn to bind the engine session",
    );
    FakeMcodeAcpClient.release();
    await turn1;
    assert.equal(res1._status, 200);
    assert.equal(sb.activeRunCount(), 0);
    assert.deepEqual(chatLines(cs), ["› first", "● ok"]);

    // Second turn on the same cid + session: beginRun registered the real
    // sid itself, so nothing is blocked.
    const res2 = fakeRes();
    const turn2 = handleSend(fakeReq({ content: "second" }), res2, { cs, cid });
    await waitFor(() => sb.getRunForCid(cid), "second turn to claim the cid");
    assert.equal(sb.getRunForCid(cid).sid, sid);
    FakeMcodeAcpClient.release();
    await turn2;
    assert.equal(res2._status, 200);
    assert.equal(sb.activeRunCount(), 0);
    assert.deepEqual(chatLines(cs), ["› first", "● ok", "› second", "● ok"]);
  });

  test("regression: cross-cid parallel turns on DIFFERENT sessions are not blocked", async () => {
    const cid1 = "cid-par-1";
    const cid2 = "cid-par-2";
    const cs1 = makeClient(cid1);
    const cs2 = makeClient(cid2);

    // Two first turns, two brand-new engine sessions, in parallel.
    const res1 = fakeRes();
    const res2 = fakeRes();
    const turn1 = handleSend(fakeReq({ content: "from one" }), res1, { cs: cs1, cid: cid1 });
    const turn2 = handleSend(fakeReq({ content: "from two" }), res2, { cs: cs2, cid: cid2 });
    assert.equal(res1._status, 200);
    assert.equal(res2._status, 200);

    await waitFor(
      () => cs1.mcodeSessionId && cs2.mcodeSessionId,
      "both turns to bind their engine sessions",
    );
    assert.notEqual(
      cs1.mcodeSessionId,
      cs2.mcodeSessionId,
      "each first turn must get its own engine session",
    );
    assert.equal(sb.activeRunCount(), 2);

    FakeMcodeAcpClient.release();
    FakeMcodeAcpClient.release();
    await Promise.all([turn1, turn2]);
    assert.equal(sb.activeRunCount(), 0);
    assert.deepEqual(chatLines(cs1), ["› from one", "● ok"]);
    assert.deepEqual(chatLines(cs2), ["› from two", "● ok"]);
  });
});
