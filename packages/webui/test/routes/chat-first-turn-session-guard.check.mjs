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

// M3-B8: this file is an ACP-TRANSPORT test — it installs a scripted
// fake of `../acp.mjs` and drives `session/new` + `session/prompt`, so
// it must not follow the suite's ambient transport now that #12 has a
// runtime sibling. The pin is a module-scope side effect and MUST stay
// the first import: `lib/config.js` freezes the transport into an
// `export const` at evaluation time, so anything later is too late.
// See test/helpers/pin-transport.mjs for the full argument.
import "../helpers/pin-transport.mjs";

import { test, describe, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {rmSync} from "node:fs";

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";
import { createTurnDrain } from "../helpers/turn-drain.mjs";

// Isolation FIRST — lib/config.js resolves SESSIONS_DB / UPLOAD_DIR from
// MCODE_WEBUI_DATA_DIR at import time, and lib/events.js resolves the
// audit-log path per append (alerts audit-writes on failed sends). Neither
// this check nor the operator's real ~/.mcode-webui may see the other.
//
// SESSIONS_DB is pinned EXPLICITLY, for the same reason as its sibling
// chat-run-mirror.check.mjs: config.js resolves it as
// `MCODE_WEBUI_SESSIONS_DB || join(WEBUI_DATA_DIR, "sessions.json")`, so an
// outer MCODE_WEBUI_SESSIONS_DB outranks the default and would leave the
// `beforeEach` below clearing a file this suite never reads. The assertions
// here happen to tolerate a store carrying records from an earlier run, so
// the hazard is latent rather than red — but a suite that writes to a store
// it does not own is one refactor away from the red sibling, and it still
// pollutes whatever store the caller pointed it at.
const _tmpDataDir = mkTmpDir("webui-first-turn-guard-");
const _sessionsDb = join(_tmpDataDir, "sessions.json");
process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
process.env.MCODE_WEBUI_SESSIONS_DB = _sessionsDb;
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
      handleCmdCommand: async () => ({ handled: true, continueMcode: false }),
      matchSlash: (content) => {
        const m = content.match(/^\/([a-zA-Z][\w-]*)\b\s*(.*)/);
        if (!m) return null;
        return { cmd: m[1], rest: m[2] || "" };
      },
    },
  });
}

let handleSend;
let switchSession;
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

// ------------------------------------------------------------------
// Turn bookkeeping — a test must never abandon a live turn.
//
// `beginRun` / `endRun` keep a PROCESS-WIDE registry (the per-conversation
// claim plus the engine-session claim in `runsBySid`), and
// `activeRunCount()` counts every live turn globally. Every assertion below that counts runs is
// therefore reading a number this file shares with every case in the
// process, and this file has no reset hook to scope it back.
//
// A case that aborts between `handleSend` and the finalize leaves its
// turn parked on the fake transport: the route never reaches
// `finally { endRun(cid, sessionId) }`, so the claim stays registered and the cases
// that follow read a count that includes a turn they never started. That
// is the cascade this file shipped with: the first case's
// `assert.equal(resB._status, 409)` is the only REAL failure, yet the two
// regression cases after it go red on `1 !== 0` and `3 !== 2` — two
// contracts blamed for a leak they did not cause. The abandoned finalize
// also persists its chat record late, after the next case's `beforeEach`
// already deleted the sessions store, which writes this case's turn into
// the next case's storage.
//
// The mechanism lives in test/helpers/turn-drain.mjs, shared with
// chat-run-mirror.check.mjs (same registry, same failure shape). The
// actions below ARE everything this file can leave behind:
//   releaseParkedPrompts — every prompt still on FakeMcodeAcpClient
//   activeRunCount       — the post-condition, read from the real bus
// There is no `session/new` gate here, so no `unblock` is supplied: a
// turn that reaches this fake transport has always got past the session
// handshake. The cleanup is a safety net, not the assertion — a leak
// still fails the case that caused it.
// ------------------------------------------------------------------
const drain = createTurnDrain({
  label: "chat-first-turn-session-guard",
  activeRunCount: () => sb.activeRunCount(),
  releaseParkedPrompts: () => {
    while (FakeMcodeAcpClient.pending.length) FakeMcodeAcpClient.release();
  },
});

before(async (t) => {
  await setupFirstTurnMocks(t);
  sb = await import(absPath("lib/state-bus.js"));
  sessions = await import(absPath("lib/sessions.js"));
  alerts = await import(absPath("lib/alerts.js"));
  const chatMod = await import(absPath("routes/chat.js"));
  handleSend = chatMod.handleSend;
  switchSession = (await import(absPath("routes/sessions.js"))).handleSwitchSession;
});

beforeEach(() => {
  sb.clients.clear();
  sb.resetCoalesceState();
  // Fresh redirected sessions store per case.
  try {
    rmSync(_sessionsDb, { force: true });
  } catch {}
  sessions._resetSessionsCacheForTests();
  alerts._resetForTests();
  FakeMcodeAcpClient.reset();
});

// Runs after EVERY test, including one that failed or threw — which is
// precisely the case that used to leak. The wait is bounded so a turn that
// cannot be unblocked reports its own failure instead of hanging the file.
afterEach(drain.cleanup);

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
    const turnA = drain.track(handleSend(fakeReq({ content: "hello" }), resA, {
      cs: csA,
      cid: cidA,
    }));

    // Mid-turn: the engine session came into existence, and the run
    // registry must now claim it (the backfill under test).
    // The run is keyed by (cid, conversation) — the claim starts on the
    // tab's draft (`sessionId: null`) and follows the record the draft
    // block creates, which is then promoted to the engine identity. Enumerate
    // the tab's runs rather than re-deriving the key: the id changes under
    // the turn, which is exactly why the view router falls back to the engine
    // sid.
    const runOf = (cid) => sb.getRunsForCid(cid).map(([, run]) => run)[0] || null;
    const sid = await waitFor(
      () => runOf(cidA) && runOf(cidA).sid,
      "run registry to carry the first turn's engine sid",
    );
    assert.match(sid, /^mvs_fake_/);
    assert.equal(csA.mcodeSessionId, sid, "cs.mcodeSessionId bound mid-turn");

    // Window B: a DIFFERENT cid already bound to that same brand-new
    // session (sidebar switch / restore after draft promotion).
    const csB = makeClient(cidB, { mcodeSessionId: sid });
    const resB = fakeRes();
    // Not tracked, and deliberately so: the 409 answers before the
    // fire-and-forget section, so this call claims no run and parks no
    // prompt — `activeRunCount() === 1` below is the proof. Tracking it
    // anyway would only add a turn that can never leak.
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
    assert.equal(runOf(cidA), null);

    // Now B may take the session, and continues the SAME engine session.
    const resB2 = fakeRes();
    const turnB2 = drain.track(handleSend(fakeReq({ content: "my turn now" }), resB2, {
      cs: csB,
      cid: cidB,
    }));
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
    const turn1 = drain.track(handleSend(fakeReq({ content: "first" }), res1, { cs, cid }));
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
    const turn2 = drain.track(handleSend(fakeReq({ content: "second" }), res2, { cs, cid }));
    await waitFor(() => sb.getRunsForCid(cid).length === 1, "second turn to claim the session");
    assert.equal(sb.getRunsForCid(cid).map(([, run]) => run)[0].sid, sid);
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
    const turn1 = drain.track(handleSend(fakeReq({ content: "from one" }), res1, { cs: cs1, cid: cid1 }));
    const turn2 = drain.track(handleSend(fakeReq({ content: "from two" }), res2, { cs: cs2, cid: cid2 }));
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


// ============================================================
// Cross-session parallel turns in ONE tab.
//
// Same harness as above (real chat.js → runMcodeAcp → sessions.js →
// state-bus, only the ACP transport is faked), because the contract under
// test IS the wiring: `handleSend` must claim the run against the
// CONVERSATION it is sending into, not against the tab.
//
// The bug: `beginRun` was keyed by `cid` alone, and `cid` is the browser-TAB
// identity (one `localStorage['webui_cid']`, stable across a session switch
// so one tab keeps one state object, one SSE channel and one engine
// connection). A long turn in session B therefore answered 409 `cid-busy`
// for every send into session A of the same tab until it finished —
// measured on a running instance (~/tmp/run_261001_001842/smoke-report.md).
// The guard that must survive the fix is the same-conversation one
// (#126 D-2): a second send into the SAME session is still a duplicate
// turn and is still refused.
// ============================================================
describe("POST /api/send — parallel turns in one tab", () => {
  /** Persist a conversation record and switch the tab's view onto it. */
  async function switchTo(cid, cs, record) {
    sessions.saveSessions([...sessions.loadSessions(), record]);
    const res = fakeRes();
    await switchSession(fakeReq({ id: record.id }), res, { cs, cid });
    assert.equal(res._status, 200, `switch to ${record.id} must succeed`);
    assert.equal(cs.sessionId, record.id);
  }

  test("a send into session A is accepted while session B's turn runs", async () => {
    const cid = "cid-one-tab-two-sessions";
    const cs = makeClient(cid);

    // Session B: a first turn that stays in flight (the fake transport
    // parks its prompt, so B is still running for the rest of the case).
    const resB = fakeRes();
    const turnB = drain.track(handleSend(fakeReq({ content: "long task in B" }), resB, { cs, cid }));
    assert.equal(resB._status, 200);
    const sidB = await waitFor(() => cs.mcodeSessionId, "B to bind its engine session");
    const idB = await waitFor(() => cs.sessionId, "B's draft record to exist");
    await waitFor(() => FakeMcodeAcpClient.pending.length === 1, "B's prompt to park");

    // The user opens session A in the same tab and sends while B streams.
    // `workspace: ""` — the switch route runs the target through the
    // containment gate, and an empty value resolves to DEFAULT_WORKSPACE
    // (the tmp `WS` above is not a real directory, so a stored value
    // pointing at it is refused with 400 — a different contract, covered
    // by routes/sessions*.test.js).
    await switchTo(cid, cs, {
      id: "web-session-A",
      title: "A",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chat: [],
      workspace: "",
    });
    assert.equal(cs.mcodeSessionId, null, "A is a different conversation");
    const resA = fakeRes();
    const turnA = drain.track(handleSend(fakeReq({ content: "meanwhile in A" }), resA, { cs, cid }));
    const sidA = await waitFor(() => cs.mcodeSessionId, "A to bind its engine session");
    assert.equal(resA._status, 200, "session A must NOT be refused by session B's turn");
    assert.notEqual(sidA, sidB, "each conversation gets its own engine session");
    assert.equal(sb.activeRunCount(), 2, "two live turns, two slots");

    // Both drain; neither turn's lines landed in the other's conversation.
    await waitFor(() => FakeMcodeAcpClient.pending.length === 2, "A's prompt to park");
    FakeMcodeAcpClient.release();
    FakeMcodeAcpClient.release();
    await Promise.all([turnA, turnB]);
    assert.equal(sb.activeRunCount(), 0);
    // A's own view carries exactly A's turn.
    assert.deepEqual(chatLines(cs), ["› meanwhile in A", "● ok"]);
    // B's turn was written back to B's persisted record, not into A's view.
    const storedB =
      sessions.loadSessions().find((s) => s.id === idB || s.mcodeSessionId === sidB);
    assert.ok(storedB, "B's record still exists");
    assert.ok(
      storedB.chat.includes("● ok"),
      "B's answer reached B's own record",
    );
    assert.equal(
      storedB.chat.includes("› meanwhile in A"),
      false,
      "A's message must not appear in B's record",
    );
  });

  // The narrow window the engine-session index cannot cover: a conversation
  // whose FIRST turn has claimed the run but whose engine session does not
  // exist yet (it is minted inside runMcodeAcp and backfilled mid-turn).
  // Only the conversation key can refuse a duplicate here, so this case is
  // what separates "the guard is keyed by conversation" from "the guard is
  // keyed by conversation AND the engine session happens to be known".
  test("a duplicate send before the engine session exists is still refused", async () => {
    const cid = "cid-duplicate-before-sid";
    const cs = makeClient(cid);

    const res1 = fakeRes();
    const turn1 = drain.track(handleSend(fakeReq({ content: "once" }), res1, { cs, cid }));
    // No wait: fire the duplicate into the same conversation while the first
    // turn is still short of its `session/new`.
    const res2 = fakeRes();
    await handleSend(fakeReq({ content: "twice" }), res2, { cs, cid });

    assert.equal(res2._status, 409, "a duplicate send is refused even with no engine session yet");
    const body = JSON.parse(res2._body);
    assert.equal(body.reason, "cid-busy", "the conversation key is what refuses it");
    assert.equal(sb.activeRunCount(), 1, "the refused send must not claim a slot");
    assert.equal(cs.mcodeSessionId, null, "the first turn has not bound an engine session yet");
    assert.deepEqual(chatLines(cs), ["› once"]);

    await waitFor(() => FakeMcodeAcpClient.pending.length === 1, "the first prompt to park");
    FakeMcodeAcpClient.release();
    await turn1;
    assert.equal(sb.activeRunCount(), 0);
  });

  test("a second send into the SAME session is still refused", async () => {
    const cid = "cid-same-session-twice";
    const cs = makeClient(cid);

    const res1 = fakeRes();
    const turn1 = drain.track(handleSend(fakeReq({ content: "once" }), res1, { cs, cid }));
    assert.equal(res1._status, 200);
    const sid = await waitFor(() => cs.mcodeSessionId, "the first turn to bind");
    await waitFor(() => FakeMcodeAcpClient.pending.length === 1, "the first prompt to park");

    // #126 D-2: the duplicate-execution guard. Same conversation, same tab.
    const res2 = fakeRes();
    await handleSend(fakeReq({ content: "twice" }), res2, { cs, cid });
    assert.equal(res2._status, 409, "a duplicate send into the same session is refused");
    const body = JSON.parse(res2._body);
    assert.equal(body.ok, false);
    // Either guard may catch it: a first turn's record is promoted from its
    // draft uuid to the engine identity mid-run, so by now the ENGINE-session
    // index is what still recognises the conversation. Both refuse.
    assert.ok(
      ["cid-busy", "session-busy"].includes(body.reason),
      `unexpected refusal reason: ${body.reason}`,
    );
    assert.equal(sb.activeRunCount(), 1, "the refused send must not claim a slot");
    // And nothing was written into the conversation.
    assert.deepEqual(chatLines(cs), ["› once"]);
    assert.equal(cs.mcodeSessionId, sid, "the refused send did not disturb the live turn");

    FakeMcodeAcpClient.release();
    await turn1;
    assert.equal(res1._status, 200);
    assert.equal(sb.activeRunCount(), 0);
    assert.deepEqual(chatLines(cs), ["› once", "● ok"]);

    // Once it finished, the same session accepts a new turn.
    const res3 = fakeRes();
    const turn3 = drain.track(handleSend(fakeReq({ content: "later" }), res3, { cs, cid }));
    // Wait for the prompt to park before releasing — `handleSend` acks
    // asynchronously, so an immediate release would find an empty queue and
    // the turn would never settle.
    await waitFor(() => FakeMcodeAcpClient.pending.length === 1, "the third prompt to park");
    assert.equal(res3._status, 200);
    FakeMcodeAcpClient.release();
    await turn3;
    assert.equal(sb.activeRunCount(), 0);
    assert.deepEqual(chatLines(cs), ["› once", "● ok", "› later", "● ok"]);
  });
});

// ------------------------------------------------------------------
// P16 — the SAME tab sending again into its own live conversation.
//
// The case above is refused by the engine-session index (`runsBySid`), which
// the runner backfills mid-turn. The one below is the wiring P16 fixed: it
// runs the REAL chat.js → runMcodeAcp → sessions.js → state-bus chain, so
// it fails if the `moveRunSession` re-key is removed from `mcode-acp.js` —
// the registry-level suite cannot see that call, and a test that restates
// the fix inside its own runner proves nothing about production.
//
// What the UAT saw (2026-10-03 16点轮 异常 #1): a second message sent into
// a running conversation was ACKed, the engine ran it (the produced file
// contained the idiom named only in that message), and the webui transcript
// and the persisted record never contained it — because the turn's echo went
// into a live `cs.chat` that the run-mirror's finalize then wrote over from
// a snapshot taken before it. "The engine ran it and the webui does not know
// it" is the exact shape this contract forbids.
// ------------------------------------------------------------------
describe("POST /api/send — P16: a send into this tab's own live turn", () => {
  test("is refused, and reaches neither the engine nor the transcript", async () => {
    const cid = "cid-P16-inflight";
    const cs = makeClient(cid);

    const res1 = fakeRes();
    const turn1 = drain.track(handleSend(fakeReq({ content: "first" }), res1, { cs, cid }));
    // Mid-turn the record is promoted from its draft uuid to the engine id,
    // and the claim has to follow it. Wait for the PROMOTED identity, not
    // for the draft: that is the state in which the UAT's second send
    // arrived, and the one the re-key exists for.
    const sid = await waitFor(
      () => (cs.mcodeSessionId ? cs.sessionId : null),
      "the draft to be promoted to the engine identity",
    );
    assert.match(sid, /^mvs_fake_/);
    // The claim is registered under the identity the VIEW now presents. This
    // is the production assertion: it reads the registry, not a runner the
    // test controls.
    assert.equal(
      sb.getRunForSession(cid, sid),
      sb.getRunsForCid(cid)[0]?.[1] ?? null,
      "the live claim must be findable under the promoted conversation id",
    );

    // The second send, from the SAME tab, into the SAME conversation.
    const res2 = fakeRes();
    await handleSend(fakeReq({ content: "守株待兔，水墨国风，滚动叙事长页" }), res2, { cs, cid });

    assert.equal(res2._status, 409, "a send into a live turn must be refused, not acked");
    const body = JSON.parse(res2._body);
    assert.equal(body.ok, false);
    assert.ok(
      ["cid-busy", "session-busy"].includes(body.reason),
      `unexpected refusal reason: ${body.reason}`,
    );
    assert.match(body.error, /NOT delivered/, "the refusal must state it was not delivered");

    // ---- the reverse half -------------------------------------------------
    // One prompt is parked on the fake transport. A second one would mean the
    // engine was handed a turn the webui had already refused.
    assert.equal(
      FakeMcodeAcpClient.pending.length,
      1,
      "a refused send must never reach the engine",
    );
    assert.deepEqual(
      chatLines(cs),
      ["› first"],
      "a refused send must not be echoed into the live transcript",
    );
    assert.equal(sb.activeRunCount(), 1, "the refused send must not claim a slot");

    // The record on disk carries the turn that ran, and nothing else.
    const stored = sessions.loadSessions().find((s) => s.id === sid);
    assert.ok(stored, "the promoted record must exist");
    assert.ok(
      !stored.chat.some((line) => String(line).includes("守株待兔")),
      "a refused send must not reach the persisted record",
    );

    // The live turn finishes normally and releases the re-keyed claim.
    FakeMcodeAcpClient.release();
    await turn1;
    assert.equal(res1._status, 200);
    await waitFor(() => sb.activeRunCount() === 0, "the re-keyed claim to be released");
    assert.equal(
      sb.getRunForSession(cid, sid),
      null,
      "the re-key must not leak the claim past the turn that held it",
    );
  });
});
