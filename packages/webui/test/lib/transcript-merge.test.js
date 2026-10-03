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
let messagesToChatLines;
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
  messagesToChatLines = transcriptLib.messagesToChatLines;
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
    // --- the `§§` annotation family (webui-parity 83) -----------------------
    // These three cases are one contract, stated per marker. An annotation is
    // metadata about the turn above it, so the engine's position is the only
    // position it can occupy: `decodeTranscript` resolves it onto the assistant
    // block above it, and a `§§ turn_msg=` that lands after a `/status` echo
    // answers that echo's "files edited" card with another turn's diff.
    {
      name: "a turn_msg the tab lacks stays on its own turn, ahead of a local echo",
      read: ["› ping", "● pong", "§§ turn_msg=m2"],
      have: ["› ping", "● pong", "› /status", "● 当前 model=X"],
      want: ["› ping", "● pong", "§§ turn_msg=m2", "› /status", "● 当前 model=X"],
    },
    {
      name: "processed_duration is placed by the same rule as turn_msg",
      read: ["› ping", "● pong", "§§ processed_duration=1200ms", "§§ turn_msg=m2"],
      have: ["› ping", "● pong", "› /help", "● 可用命令："],
      want: [
        "› ping",
        "● pong",
        "§§ processed_duration=1200ms",
        "§§ turn_msg=m2",
        "› /help",
        "● 可用命令：",
      ],
    },
    {
      name: "the rule is marker-agnostic: a tool-call marker (`##tc:`) is placed the same way",
      // `##tc:` is slice 06, not `§§`, and it is written the same way — into
      // the array the browser reads, immediately before the `→ name` header it
      // annotates. Pinned here so a future edit that special-cases the `§§`
      // family by name cannot pass this suite.
      read: ["› ping", "● pong", "##tc:call-7", "→ bash  {}", "  [completed]", "● 好了"],
      have: ["› ping", "● pong", "→ bash  {}", "  [completed]", "● 好了", "› /status", "● 当前 model=X"],
      want: [
        "› ping",
        "● pong",
        "##tc:call-7",
        "→ bash  {}",
        "  [completed]",
        "● 好了",
        "› /status",
        "● 当前 model=X",
      ],
    },
    {
      name: "an un-annotated chat is not replayed: every marker lands on its own turn",
      // The regression this rule exists for. With the marker treated as an
      // ordinary line the engine cursor stalls at the first `§§` and the whole
      // remaining conversation is appended behind the tab's own copy.
      read: ["› q1", "● a1", "§§ turn_msg=M1", "› q2", "● a2", "§§ turn_msg=M2"],
      have: ["› q1", "● a1", "› q2", "● a2"],
      want: ["› q1", "● a1", "§§ turn_msg=M1", "› q2", "● a2", "§§ turn_msg=M2"],
    },
    {
      name: "a foreign turn keeps its marker when a local echo precedes it",
      read: ["› ping", "● pong", "§§ turn_msg=m2", "› hi", "● hey", "§§ turn_msg=m3"],
      have: ["› ping", "● pong", "› /status", "● 当前 model=X"],
      want: [
        "› ping",
        "● pong",
        "§§ turn_msg=m2",
        "› /status",
        "● 当前 model=X",
        "› hi",
        "● hey",
        "§§ turn_msg=m3",
      ],
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
// 2. Lossy streaming mirrors retire
// ============================================================
//
// The defect this section pins. The merge contract above was written for
// lines the webui AUTHORS. It was then applied to lines the webui MIRRORS,
// and the mirror is lossy by construction:
//
//   mcode-acp.js (stream `message`/`thought` chunk) and routes/chat.js:341
//   (finalize) write ONE line, `prefix + r.answer.replace(/\n+/g," ").trim()`,
//   where the engine's own mapper (`_proseLines`) keeps ONE ARRAY ENTRY PER
//   SOURCE LINE. The two can never be byte-equal, so the lockstep walk called
//   every mirror "webui-authored", kept it, and then appended the engine's
//   whole spine behind it. A tool header lost its args the same way (`→ bash`
//   against the engine's `→ bash  {json}`), so the tool block doubled too.
//
// Observed on a live UAT session: 81 stored lines, of which 14 were a second
// copy of engine content that was not in the transcript a minute earlier —
// and `persistCurrentChat` wrote the duplicate back to disk, so a reload kept
// showing it. The mirrored shapes are reproduced structurally below; the
// numbers are that session's (16 mirror lines against a 67-line engine read),
// the prose is synthetic.

describe("mergeEngineTranscript — a lossy streaming mirror retires", () => {
  // The engine's source text for one turn. The shape is what matters:
  // blank lines (which become `● ` placeholders on the engine side and a
  // single collapsed space in the mirror), a fenced code block with real
  // indentation, and a markdown table. All three are places a naive
  // "same line" compare diverges from a "same content" compare.
  const THINKING = [
    "The directory is empty.",
    "",
    "Now let me provide the results.",
    "",
    "Let me pick a topic for the table.",
  ].join("\n");
  const ANSWER = [
    "All three items are done, results below.",
    "",
    "## 1) directory listing",
    "",
    "```",
    "total 44",
    "drwxr-xr-x  2 u u 4096 Oct  3 09:25 .",
    "drwxrwxr-x 501 u u 4096 Oct  3 09:25 ..",
    "```",
    "",
    "## 2) table",
    "",
    "| lang | complexity | use |",
    "|---|---|---|",
    "| Python | O(n²) | teaching |",
    "| Java | O(n log n) | backend |",
    "",
    "## 3) code",
    "",
    "```python",
    "def bubble_sort(arr):",
    "    n = len(arr)",
    "    for i in range(n - 1):",
    "        if arr[i] > arr[i + 1]:",
    "            arr[i], arr[i + 1] = arr[i + 1], arr[i]",
    "    return arr",
    "```",
  ].join("\n");

  // The engine's own view: exactly the rows the runtime DB returned, fed
  // through the production mapper so the fixture cannot drift from it.
  const ENGINE_MESSAGES = [
    { role: "user", content: "list the directory, then a table, then code", turnId: "t1" },
    {
      role: "assistant",
      content: "I'll start by checking the workspace directory.",
      turnId: "t1",
      tool_calls: [
        {
          name: "bash",
          arguments: '{"command":"ls -la"}',
          status: "completed",
          result: "total 44\ndrwxr-xr-x  2 u u 4096 Oct  3 09:25 .",
        },
      ],
    },
    { role: "assistant", thinking: THINKING, content: ANSWER, turnId: "t1", msgId: "M3" },
  ];

  /** The engine side of the merge, byte-for-byte what the poller reads. */
  const engineLines = () => messagesToChatLines(ENGINE_MESSAGES).lines;

  /**
   * The webui side: what the streaming writers actually put in `cs.chat`.
   * `fold` is the flatten the answer/thinking branches apply; the tool header
   * is written bare because the frame carried no `rawInput`.
   */
  const mirrorLines = ({ fold = true, toolArgs = false } = {}) => {
    const lines = [
      "› list the directory, then a table, then code",
      "● I'll start by checking the workspace directory.",
      "##tc:call_1",
      toolArgs ? '→ bash  {"command":"ls -la"}' : "→ bash",
      "  [completed]",
      "  total 44",
      "  drwxr-xr-x  2 u u 4096 Oct  3 09:25 .",
      "  drwxrwxr-x 501 u u 4096 Oct  3 09:25 ..",
      "  ",
      "  [in_progress]",
      "  [completed]",
      fold ? `▲ ${THINKING.replace(/\n+/g, " ").trim()}` : "▲ The directory is empty.",
      fold ? `● ${ANSWER.replace(/\n+/g, " ").trim()}` : "● All three items are done, results below.",
      "§§ processed_duration=11071ms",
      "§§ turn_msg=M3",
    ];
    return lines;
  };

  const countOf = (lines, needle) => lines.filter((l) => l === needle).length;

  test("the flattened mirror answer retires: one rendered copy, the engine's per-line one", () => {
    const read = engineLines();
    const have = mirrorLines();
    const merged = mergeEngineTranscript(read, have);

    // The mirror line itself is gone, and so is the flattened thinking line.
    assert.equal(countOf(merged, `● ${ANSWER.replace(/\n+/g, " ").trim()}`), 0);
    assert.equal(countOf(merged, `▲ ${THINKING.replace(/\n+/g, " ").trim()}`), 0);
    // What is left is the engine's line-by-line version — every source line
    // once, in order. The whole answer is present exactly once.
    const answerLines = merged.filter((l) => l.startsWith("● "));
    assert.equal(answerLines.length, 1 + ANSWER.split("\n").length);
    assert.ok(merged.includes("● ## 3) code"), "the folded answer is rendered per line");
    assert.ok(merged.includes("●     for i in range(n - 1):"), "indentation survives");
  });

  test("the lossy `→ bash` header retires: one tool block, carrying the engine's args", () => {
    const read = engineLines();
    const have = mirrorLines();
    const merged = mergeEngineTranscript(read, have);

    assert.equal(countOf(merged, "→ bash"), 0, "the arg-less mirror header is retired");
    assert.equal(countOf(merged, '→ bash  {"command":"ls -la"}'), 1, "exactly one tool header");
    // The mirror's redundant body lines go with it; the engine's body is the
    // one that renders, and the streaming-only `[in_progress]` marker is not
    // carried over into a finished turn.
    assert.equal(countOf(merged, "  [in_progress]"), 0);
    assert.equal(countOf(merged, "  [completed]"), 1);
    assert.equal(countOf(merged, "  total 44"), 1);
  });

  test("no engine line is lost and the webui's own annotations stay", () => {
    const read = engineLines();
    const merged = mergeEngineTranscript(read, mirrorLines());
    for (const line of read) {
      assert.ok(merged.includes(line), "engine line dropped: " + JSON.stringify(line));
    }
    // Neither of these ever reaches the engine DB, so neither can be retired.
    assert.ok(merged.includes("##tc:call_1"), "the tool-call correlation marker stays");
    assert.ok(
      merged.includes("§§ processed_duration=11071ms"),
      "the per-turn duration marker this webui writes stays",
    );
  });

  test("a webui-local `› /help` echo still survives the merge that retires mirrors", () => {
    // The reverse half, and the guard on over-reach: the retirement runs in
    // this merge (both mirrors above did retire) and the local echo is
    // still there. This is the #126 behaviour the merge exists for.
    const read = engineLines();
    const have = ["› /help", "● available commands:", "  /new", ...mirrorLines()];
    const merged = mergeEngineTranscript(read, have);

    assert.ok(merged.includes("› /help"), "local echo kept: " + JSON.stringify(merged.slice(0, 4)));
    assert.ok(merged.includes("● available commands:"));
    assert.ok(merged.includes("  /new"));
    // …and the retirement still happened in the same pass.
    assert.equal(countOf(merged, `● ${ANSWER.replace(/\n+/g, " ").trim()}`), 0);
    assert.equal(countOf(merged, '→ bash  {"command":"ls -la"}'), 1);
  });

  test("a short local answer the engine never saw is not mistaken for a mirror", () => {
    // The `● pong` of a `/status` echo, sitting at a cursor that holds
    // different engine text. Folding cannot match text the engine does not
    // have, so the line stays — the case a "looks like a mirror" heuristic
    // gets wrong.
    const read = ["› ping", "● the engine answered something else"];
    const have = ["› ping", "● pong", "● current model=X"];
    const merged = mergeEngineTranscript(read, have);
    assert.ok(merged.includes("● pong"), "the local answer is kept: " + JSON.stringify(merged));
    assert.ok(merged.includes("● current model=X"));
    // The engine's own answer still lands (it is content this tab has not
    // seen), behind the local lines — unchanged from before.
    assert.ok(merged.includes("● the engine answered something else"));
  });

  test("a same-glyph run that folds to something else keeps the mirror", () => {
    // The engine's `●` run is real, but it is not what the local line says.
    // Retirement is an identity test, so a miss keeps the line (the old
    // double render) — it never drops content on a shape resemblance.
    const read = ["› ping", "● alpha", "● beta"];
    const have = ["› ping", "● alpha beta gamma"];
    const merged = mergeEngineTranscript(read, have);
    assert.ok(merged.includes("● alpha beta gamma"), "mirror kept: " + JSON.stringify(merged));
  });

  test("a tool header for a different tool does not retire", () => {
    // Ordered consumption by name: `→ other_tool` is not a lossy copy of
    // `→ bash`, however similar the two blocks look, so the mirror header
    // and the body streamed under it both stay.
    const read = ["→ bash  {\"command\":\"ls\"}"];
    const have = ["→ other_tool", "  streamed body the engine has not stored"];
    const merged = mergeEngineTranscript(read, have);
    assert.ok(merged.includes("→ other_tool"), "mirror header kept: " + JSON.stringify(merged));
    assert.ok(merged.includes("  streamed body the engine has not stored"));
  });

  test("the merge stays pure: retirement does not touch either input", () => {
    const read = engineLines();
    const have = mirrorLines();
    const readCopy = [...read];
    const haveCopy = [...have];
    mergeEngineTranscript(read, have);
    assert.deepEqual(read, readCopy);
    assert.deepEqual(have, haveCopy);
  });
});

// ============================================================
// 3. The UAT shape: 81 stored lines → no duplicated answer
// ============================================================
//
// The line counts are the real ones from the UAT session whose stored chat
// was 81 lines against a 67-line engine read; 14 of the 81 were a second copy
// of engine content. The prose is synthetic — only the STRUCTURE is quoted
// (one flattened `▲`, one flattened `●`, a bare `  ` block terminator, a
// `[in_progress]` status line, a `##tc:` marker and a `§§` pair the engine
// never stores). This is the regression assertion in its end-to-end shape:
// merge the live mirror against the engine read and count the copies.

describe("the UAT 81-line shape loses its duplicate answer", () => {
  // A 9-line thinking chain and a 25-line answer: the UAT turn's engine read
  // was 67 lines, its mirror 16.
  const UAT_THINKING = [
    "The directory is empty.",
    "",
    "Now let me provide the results.",
    "",
    "Let me think about the report.",
    "",
    "Note: no file deliverables are needed here.",
    "",
    "Let me pick a topic for the table.",
  ].join("\n");
  const UAT_ANSWER = [
    "All three items are done, results below.",
    "",
    "## 1) directory listing",
    "",
    "the actual output of the listing command:",
    "",
    "```",
    "total 44",
    "drwxr-xr-x  2 u u 4096 Oct  3 09:25 .",
    "drwxrwxr-x 501 u u 4096 Oct  3 09:25 ..",
    "```",
    "",
    "Conclusion: the working directory is empty — only . and .. are present. The owner and the group are the current user, and the link count on .. reflects the 501 entries of the parent.",
    "",
    "## 2) markdown table (3 columns, header included)",
    "",
    "| language | average complexity | typical use |",
    "|---|---|---|",
    "| Python | O(n²) | teaching, small inputs |",
    "| Java | O(n log n) | enterprise backends |",
    "| Rust | O(n log n) | systems, embedded |",
    "| Go | O(n log n) | microservices |",
    "",
    "## 3) python bubble sort",
    "",
    "```python",
    "def bubble_sort(arr):",
    '    """In-place bubble sort: swap adjacent out-of-order pairs."""',
    "    n = len(arr)",
    "    for i in range(n - 1):",
    "        swapped = False",
    "        # the right edge shrinks every round",
    "        for j in range(n - 1 - i):",
    "            if arr[j] > arr[j + 1]:",
    "                arr[j], arr[j + 1] = arr[j + 1], arr[j]",
    "                swapped = True",
    "        if not swapped:",
    "            break",
    "    return arr",
    "",
    "",
    'if __name__ == "__main__":',
    '    data = [64, 34, 25, 12, 22, 11, 90]',
    '    print("before:", data)',
    '    print("after: ", bubble_sort(data))',
    "```",
    "",
    "The early exit costs nothing on average and keeps the best case at O(n); the worst case is O(n²) with O(1) extra space, and the sort is stable, so equal elements keep their relative order.",
    "",
    "Tell me if you want the table extended.",
  ].join("\n");

  const UAT_MESSAGES = [
    { role: "user", content: "do the three things", turnId: "t9" },
    {
      role: "assistant",
      content: "I'll start by checking the workspace directory.",
      turnId: "t9",
      tool_calls: [
        {
          name: "bash",
          arguments: '{"command":"ls -la","description":"list the working directory"}',
          status: "completed",
          result: "total 44\ndrwxr-xr-x  2 u u 4096 Oct  3 09:25 .\ndrwxrwxr-x 501 u u 4096 Oct  3 09:25 ..",
        },
      ],
    },
    { role: "assistant", thinking: UAT_THINKING, content: UAT_ANSWER, turnId: "t9", msgId: "M3" },
  ];

  // Built per test rather than at collection time: `messagesToChatLines` is
  // bound in the `before` hook, which has not run when the describe body is
  // evaluated.
  const uatRead = () => messagesToChatLines(UAT_MESSAGES).lines;

  // What the streaming writers had put in `cs.chat` before the poll: 16 lines,
  // the mirror. This is the array that grew to 81 once the merge kept it and
  // appended the 67-line engine spine behind it.
  const UAT_MIRROR = [
    "› do the three things",
    "● I'll start by checking the workspace directory.",
    "##tc:call_function_1",
    "→ bash",
    "  [completed]",
    "  total 44",
    "  drwxr-xr-x  2 u u 4096 Oct  3 09:25 .",
    "  drwxrwxr-x 501 u u 4096 Oct  3 09:25 ..",
    "  ",
    "  [in_progress]",
    "  [completed]",
    "  [completed]",
    `▲ ${UAT_THINKING.replace(/\n+/g, " ").trim()}`,
    `● ${UAT_ANSWER.replace(/\n+/g, " ").trim()}`,
    "§§ processed_duration=11071ms",
    "§§ turn_msg=M3",
  ];

  test("the engine read is 67 lines and the mirror is 16", () => {
    // The shape is the point of the fixture; if the engine mapper changes
    // these numbers, this test says so instead of silently re-baselining.
    assert.equal(uatRead().length, 67);
    assert.equal(UAT_MIRROR.length, 16);
  });

  test("the merged transcript renders the answer once, not twice", () => {
    const UAT_READ = uatRead();
    const merged = mergeEngineTranscript(UAT_READ, UAT_MIRROR);

    // The UAT figure the user saw: 81 lines, 14 of them a duplicate. The
    // merge now lands on the engine's 67 plus the three lines only this
    // webui authors.
    assert.equal(merged.length, 67 + 3);

    // Nothing the engine holds is dropped …
    for (const line of UAT_READ) {
      assert.ok(merged.includes(line), "engine line dropped: " + JSON.stringify(line));
    }

    // … and the two folded mirrors are gone, so the answer and the thinking
    // chain each render once — this is the assertion that fails on the
    // pre-fix code, where all three are present twice.
    assert.ok(
      !merged.includes(`● ${UAT_ANSWER.replace(/\n+/g, " ").trim()}`),
      "the folded answer mirror survived",
    );
    assert.ok(
      !merged.includes(`▲ ${UAT_THINKING.replace(/\n+/g, " ").trim()}`),
      "the folded thinking mirror survived",
    );
    assert.equal(merged.filter((l) => l === "→ bash").length, 0, "the arg-less tool header survived");
    assert.equal(merged.filter((l) => l.startsWith('→ bash  {')).length, 1);

    // The lines that survive without an engine counterpart are exactly the
    // ones this webui authors and the engine never stores — the tool-call
    // correlation marker and the per-turn duration.
    const webuiOnly = merged.filter((l) => !UAT_READ.includes(l));
    assert.deepEqual(webuiOnly, ["##tc:call_function_1", "§§ processed_duration=11071ms"]);
  });

  test("a second poll over the already-merged transcript is a no-op", () => {
    // The poller runs every 4s. Once the mirrors are gone there is nothing
    // left to retire, so the result must be stable — otherwise every tick
    // would re-push a full-state frame forever.
    const once = mergeEngineTranscript(uatRead(), UAT_MIRROR);
    assert.deepEqual(mergeEngineTranscript(uatRead(), once), once);
  });
});

// ============================================================
// 4. The poller is wired to the merge
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

    // The engine read carries a third line: the v2 rows above give the turn the
    // msg_id `m2`, and `messagesToChatLines` synthesises `§§ turn_msg=m2` for
    // it (webui-parity 83). It has to be in the MERGED result — `decodeTranscript`
    // consumes it into `assistantMessageId`, which is how the turn-diff card
    // asks the engine for THIS turn instead of its latest one. It has to be
    // right after `● pong` as well: the decoder resolves an annotation onto the
    // assistant block above it, so a tail position would hand turn `m2`'s
    // coordinate to the `/status` echo.
    assert.deepEqual(
      stateBus.clients.get("cid-d1").chat,
      [
        "› ping",
        "● pong",
        "§§ turn_msg=m2",
        "› /status",
        "● 当前 model=minimax_api/MiniMax-M3",
      ],
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
