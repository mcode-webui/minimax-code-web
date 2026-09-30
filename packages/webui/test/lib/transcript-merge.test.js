// webui/test/lib/transcript-merge.test.js
//
// webui-parity 81 D-1 — the `/api/cmd` echo must survive the transcript
// poll.
//
// The defect: `lib/transcript-sync.js` polled the engine runtime DB every
// 4s and assigned `cs.chat = read.lines` outright. The slash-command echo
// this server authors (`› /help`, `● 当前 model=…`, `● 可用命令：…`) never
// reaches the engine, so the poll deleted it seconds after the user asked
// for it and then persisted the deletion. Reproduced on a live instance:
// `POST /api/cmd /status` → 200, the echo was on the wire at t+200ms, and
// by the next tick the transcript was back to the engine's two lines.
//
// Two layers are pinned here, because either one alone leaves the bug
// reachable:
//   1. `mergeEngineTranscript` — the pure merge, table-driven.
//   2. `syncTranscriptsOnce` — the poller really is wired to the merge, and
//      the command echo really does survive a tick against a real sqlite DB.
//      A pure-function test alone would stay green if the poller went back
//      to `cs.chat = read.lines`.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setupMocks, absPath } from "../helpers/_setup.js";
import { mkTmpDir } from "../helpers/tmp.js";

const MVS = "mvs_aaaa1111bbbb2222cccc3333dddd4444";

let mergeEngineTranscript;
let syncTranscriptsOnce;
let transcriptChanged;
let stateBus;
let transcriptLib;
let tmpDir;
let dbPath;
let Database;

before(async (t) => {
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
  });
  transcriptLib = await import(absPath("lib/transcript.js"));
  mergeEngineTranscript = transcriptLib.mergeEngineTranscript;
  const ts = await import(absPath("lib/transcript-sync.js"));
  syncTranscriptsOnce = ts.syncTranscriptsOnce;
  transcriptChanged = ts.transcriptChanged;
  stateBus = await import(absPath("lib/state-bus.js"));

  tmpDir = mkTmpDir("mcode-webui-d1-merge-");
  dbPath = join(tmpDir, "runtime.sqlite");
  writeFileSync(dbPath, "");
  // The v2 runtime schema: this is the probe `loadTranscriptChatLines`
  // actually hits against a live runtime-state.sqlite. The rows below are
  // the engine's own view — a user turn and its answer, and nothing else.
  const require = createRequire(import.meta.url);
  Database = require(absPath("../../../node_modules/better-sqlite3"));
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE local_runtime_message_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT, msg_id TEXT, role TEXT, turn_id TEXT,
    created_at_ms INTEGER, data_json TEXT, source TEXT, source_context_json TEXT
  )`);
  const insert = db.prepare(`INSERT INTO local_runtime_message_rows
    (session_id, msg_id, role, turn_id, created_at_ms, data_json)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(MVS, "m1", "user", "t1", 1, JSON.stringify({ role: "user", msg_content: "ping" }));
  insert.run(MVS, "m2", "assistant", "t1", 2, JSON.stringify({ role: "assistant", msg_content: "pong" }));
  db.close();
});

after(() => {
  stateBus.clients.clear();
  stateBus.sseByCid.clear();
  stateBus.resetCoalesceState();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal SSE response stand-in the poller can write to. */
function fakeSse() {
  const written = [];
  return {
    written,
    writableEnded: false,
    destroyed: false,
    writableNeedDrain: false,
    write(chunk) {
      written.push(String(chunk));
      return true;
    },
  };
}

// ============================================================
// 1. The merge contract
// ============================================================

describe("mergeEngineTranscript — the engine read is a spine, not a replacement", () => {
  // Table-driven on purpose: the whole contract is "keep what the engine does
  // not know about, in place, and still take the engine's new lines".
  const CASES = [
    {
      name: "identical input is a no-op",
      read: ["› ping", "● pong"],
      have: ["› ping", "● pong"],
      want: ["› ping", "● pong"],
    },
    {
      name: "a webui slash-command echo written after the engine's last line survives",
      read: ["› ping", "● pong"],
      have: ["› ping", "● pong", "› /status", "● 当前 model=X"],
      want: ["› ping", "● pong", "› /status", "● 当前 model=X"],
    },
    {
      name: "a command echo BETWEEN engine lines keeps its position",
      read: ["› ping", "● pong"],
      have: ["› /help", "› ping", "● pong"],
      want: ["/help", "› ping", "● pong"].map((l, i) => (i === 0 ? "› /help" : l)),
    },
    {
      name: "a turn another client ran is appended, not dropped",
      read: ["› ping", "● pong", "› hi", "● hey"],
      have: ["› ping", "● pong"],
      want: ["› ping", "● pong", "› hi", "● hey"],
    },
    {
      name: "local lines and a foreign turn are both kept",
      read: ["› ping", "● pong", "› hi", "● hey"],
      have: ["› ping", "● pong", "› /status", "● 当前 model=X"],
      want: ["› ping", "● pong", "› /status", "● 当前 model=X", "› hi", "● hey"],
    },
    {
      name: "an empty engine read keeps everything the webui has",
      read: [],
      have: ["› ping", "› /status"],
      want: ["› ping", "› /status"],
    },
    {
      name: "a local tail the engine has not caught up with is kept whole",
      read: ["› ping"],
      have: ["› ping", "› /help", "● 可用命令：", "  /new"],
      want: ["› ping", "› /help", "● 可用命令：", "  /new"],
    },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      assert.deepEqual(mergeEngineTranscript(c.read, c.have), c.want);
    });
  }

  test("non-array inputs degrade to the array that is there", () => {
    assert.deepEqual(mergeEngineTranscript(null, ["a"]), ["a"]);
    assert.deepEqual(mergeEngineTranscript(["a"], undefined), ["a"]);
    assert.deepEqual(mergeEngineTranscript(null, null), []);
  });

  test("the merge never mutates its inputs", () => {
    const read = ["› ping"];
    const have = ["› ping", "› /status"];
    const readCopy = [...read];
    const haveCopy = [...have];
    mergeEngineTranscript(read, have);
    assert.deepEqual(read, readCopy);
    assert.deepEqual(have, haveCopy);
  });
});

// ============================================================
// 2. The poller is wired to the merge
// ============================================================

describe("syncTranscriptsOnce — the /api/cmd echo survives a poll tick", () => {
  beforeEach(() => {
    stateBus.clients.clear();
    stateBus.sseByCid.clear();
    stateBus.resetCoalesceState();
  });

  function registerClient(chat) {
    const cs = stateBus.makeClientState();
    cs.chat = [...chat];
    cs.mcodeSessionId = MVS;
    cs.running = { ...cs.running, active: false };
    stateBus.clients.set("cid-d1", cs);
    const sse = fakeSse();
    stateBus.setSseClient("cid-d1", sse);
    return sse;
  }

  /** Append a turn to the runtime DB, as another client (desktop / TUI) would. */
  function appendForeignTurn(user, assistant) {
    const db = new Database(dbPath);
    const insert = db.prepare(`INSERT INTO local_runtime_message_rows
      (session_id, msg_id, role, turn_id, created_at_ms, data_json)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const at = db.prepare("SELECT COALESCE(MAX(created_at_ms), 0) + 1 AS n FROM local_runtime_message_rows").get().n;
    insert.run(MVS, `u${at}`, "user", `t${at}`, at, JSON.stringify({ role: "user", msg_content: user }));
    insert.run(MVS, `a${at}`, "assistant", `t${at}`, at + 1, JSON.stringify({ role: "assistant", msg_content: assistant }));
    db.close();
  }

  test("the D-1 shape: a command echo is NOT truncated by the poll", () => {
    // This is the defect, verbatim: the engine knows about `ping`/`pong`, and
    // the webui then appends the output of a /api/cmd command. The old code
    // assigned the engine's two lines over the four and the user saw the echo
    // for a few seconds and then nothing — on a live instance that is exactly
    // what the probe recorded (echo at t+200ms, gone by the next tick).
    registerClient(["› ping", "● pong"]);
    // What `interaction/commands.js#bodyStatus` appends.
    stateBus.clients.get("cid-d1").chat = [
      "› ping",
      "● pong",
      "› /status",
      "● 当前 model=minimax_api/MiniMax-M3",
    ];

    syncTranscriptsOnce({ dbPath });

    assert.deepEqual(
      stateBus.clients.get("cid-d1").chat,
      ["› ping", "● pong", "› /status", "● 当前 model=minimax_api/MiniMax-M3"],
      "the command echo must still be in the transcript after the tick",
    );
  });

  test("a command echo survives a tick that ALSO pulls in a foreign turn", () => {
    // Both directions at once: the merge must not trade the local echo for
    // the engine's new content, and the push must carry both.
    registerClient(["› ping", "● pong", "› /status", "● 当前 model=X"]);
    const sse = stateBus.getSseClient("cid-d1");
    appendForeignTurn("hi", "hey");
    sse.written.length = 0;

    const refreshed = syncTranscriptsOnce({ dbPath });
    assert.deepEqual(refreshed, ["cid-d1"]);
    const chat = stateBus.clients.get("cid-d1").chat;
    assert.ok(chat.includes("› /status"), "local echo kept: " + JSON.stringify(chat));
    assert.ok(chat.includes("● hey"), "foreign turn pulled in: " + JSON.stringify(chat));
    const pushed = sse.written.join("");
    assert.ok(pushed.includes("› /status"), "the SSE frame must carry the echo");
    assert.ok(pushed.includes("● hey"), "the SSE frame must carry the foreign turn");
  });

  test("a tick with nothing new stays silent instead of re-pushing every 4s", () => {
    registerClient(["› ping", "● pong", "› /help", "● 可用命令："]);
    syncTranscriptsOnce({ dbPath });
    const sse = stateBus.getSseClient("cid-d1");
    sse.written.length = 0;
    // Second tick, same state: the merged result equals what is already
    // there, so there is nothing to say.
    const refreshed = syncTranscriptsOnce({ dbPath });
    assert.deepEqual(refreshed, []);
    assert.deepEqual(sse.written, [], "no redundant full-state frame");
  });

});

describe("transcriptChanged \u2014 the 'did it move' gate, on its own contract", () => {
  // Tested directly rather than only through the poller. For the CURRENT
  // merge a length+last-line check is provably equivalent: the merged list
  // always contains the previous one in order, so an equal length means every
  // line lined up (verified exhaustively over all length-3 lists). That makes
  // the cheap check an equivalent mutant for THIS caller \u2014 and equivalence
  // is a property of the caller, not of the function. `transcriptChanged` is
  // exported and states a general contract, and a future merge that reorders
  // would silently stop refreshing. The cases below are the ones the cheap
  // check gets wrong.
  const GATE = [
    { name: "identical lists have not moved", prev: ["a", "b", "c"], next: ["a", "b", "c"], want: false },
    { name: "the same reference has not moved", want: false, sameRef: true },
    { name: "a new line at the end is a move", prev: ["a"], next: ["a", "b"], want: true },
    {
      name: "a changed middle line with the same length AND the same tail is a move",
      prev: ["a", "x", "c"],
      next: ["a", "y", "c"],
      want: true,
    },
    { name: "a reordered middle is a move", prev: ["a", "x", "c"], next: ["a", "c", "x"], want: true },
    { name: "a dropped line is a move", prev: ["a", "b", "c"], next: ["a", "c"], want: true },
    { name: "two empty lists have not moved", prev: [], next: [], want: false },
  ];

  for (const c of GATE) {
    test(c.name, () => {
      const prev = c.sameRef ? ["a", "b"] : c.prev;
      const next = c.sameRef ? prev : c.next;
      assert.equal(transcriptChanged(prev, next), c.want);
    });
  }

  test("a non-array argument is treated as a move, never as 'unchanged'", () => {
    assert.equal(transcriptChanged(null, ["a"]), true);
    assert.equal(transcriptChanged(["a"], null), true);
    assert.equal(transcriptChanged(undefined, undefined), true);
  });
});

describe("the merge is the exported, single definition", () => {
  test("transcript.js exports it and the poller imports that symbol", () => {
    assert.equal(typeof transcriptLib.mergeEngineTranscript, "function");
    // Source-level tripwire: the poller must not reintroduce the
    // wholesale assignment. A functional test would still pass if the
    // merge were called and then overwritten on the next line.
    const src = readFileSync(fileURLToPath(absPath("lib/transcript-sync.js")), "utf8");
    assert.ok(
      !/cs\.chat\s*=\s*read\.lines/.test(src),
      "transcript-sync must not assign the engine read over cs.chat",
    );
    assert.ok(
      /mergeEngineTranscript\(read\.lines,/.test(src),
      "transcript-sync must fold the engine read in through mergeEngineTranscript",
    );
  });
});
